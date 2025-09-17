import { sql } from "bun";
import { chromium } from "playwright";

function parseDockerHubImage(
  image: string
): { namespace: string | null; repository: string } | null {
  const regex =
    /^(?:([a-z0-9]+(?:[_-][a-z0-9]+)*)\/)?([a-z0-9]+(?:[_-][a-z0-9]+)*)\.png$/;
  const match = image.match(regex);

  if (!match) return null;

  const [, namespace, repository] = match;
  return {
    namespace: namespace ?? null, // root images have no namespace
    // @ts-expect-error
    repository
  };
}

// Color codes for terminal output
const colors = {
  reset: "\x1b[0m",
  bright: "\x1b[1m",
  dim: "\x1b[2m",

  // Text colors
  black: "\x1b[30m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
  gray: "\x1b[90m",

  // Background colors
  bgRed: "\x1b[41m",
  bgGreen: "\x1b[42m",
  bgYellow: "\x1b[43m",
  bgBlue: "\x1b[44m"
};

// Get color based on status code
function getStatusColor(status: number): string {
  if (status >= 200 && status < 300) return colors.green;
  if (status >= 300 && status < 400) return colors.cyan;
  if (status >= 400 && status < 500) return colors.yellow;
  if (status >= 500) return colors.red;
  return colors.white;
}

// Get color based on HTTP method
function getMethodColor(method: string): string {
  switch (method) {
    case "GET":
      return colors.blue;
    case "POST":
      return colors.green;
    case "PUT":
      return colors.yellow;
    case "DELETE":
      return colors.red;
    case "PATCH":
      return colors.magenta;
    default:
      return colors.white;
  }
}

// Get duration color based on performance
function getDurationColor(duration: number): string {
  if (duration < 100) return colors.green;
  if (duration < 500) return colors.yellow;
  if (duration < 1000) return colors.magenta;
  return colors.red;
}

// Logging utility
function logRequest(
  method: string,
  url: string,
  status: number,
  duration: number
) {
  const timestamp = new Date().toISOString();
  const methodColor = getMethodColor(method);
  const statusColor = getStatusColor(status);
  const durationColor = getDurationColor(duration);

  console.log(
    `${colors.gray}[${timestamp}]${colors.reset} ` +
      `${methodColor}${colors.bright}${method.padEnd(7)}${colors.reset} ` +
      `${colors.cyan}${url}${colors.reset} - ` +
      `${statusColor}${colors.bright}${status}${colors.reset} - ` +
      `${durationColor}${duration.toFixed(2)}ms${colors.reset}`
  );
}

// Ensure table exists
await sql`
  CREATE TABLE IF NOT EXISTS icons (
    id BIGSERIAL PRIMARY KEY,
    namespace VARCHAR(1000) UNIQUE NOT NULL,
    url TEXT,
    content BYTEA,
    content_type TEXT,
    updated_at TIMESTAMP DEFAULT NOW()
  )
`;

const server = Bun.serve({
  port: import.meta.env.PORT ?? 8936,
  async fetch(req) {
    const startTime = performance.now();
    const method = req.method;
    const url = new URL(req.url);
    const fullPath = url.pathname + url.search; // Include query parameters

    let response: Response;

    try {
      if (method !== "GET") {
        response = new Response("Method Not Allowed", {
          status: 405,
          headers: {
            Allow: "GET",
            "Content-Type": "text/plain"
          }
        });
        logRequest(method, fullPath, 405, performance.now() - startTime);
        return response;
      }

      if (url.pathname === "/health") {
        const res = await sql`SELECT true`.values();
        response = Response.json({ SQL: res[0][0] });
        logRequest(method, fullPath, 200, performance.now() - startTime);
        return response;
      }

      const regex =
        /^(?:([a-z0-9]+(?:[_-][a-z0-9]+)*)\/)?([a-z0-9]+(?:[_-][a-z0-9]+)*)\.png$/;

      if (!url.pathname.substring(1).match(regex)) {
        response = Response.json(
          { message: "page not found" },
          { status: 404 }
        );
        logRequest(method, fullPath, 404, performance.now() - startTime);
        return response;
      }

      const image = url.pathname.substring(1);

      const parsedImage = parseDockerHubImage(image);
      if (!parsedImage) {
        response = Response.json(
          { message: "the image is not a valid docker hub image" },
          { status: 400 }
        );
        logRequest(method, fullPath, 400, performance.now() - startTime);
        return response;
      }

      // Official dockerhub images → fixed URL
      if (!parsedImage.namespace || parsedImage.namespace === "library") {
        const libUrl = `https://hub.docker.com/api/media/repos_logo/v1/library%2F${parsedImage.repository}?type=logo`;
        const fresh = await fetch(libUrl);
        response = new Response(await fresh.arrayBuffer(), {
          headers: {
            "Content-Type": fresh.headers.get("content-type") ?? "image/png",
            "Cache-Control": "public, max-age=86400" // 1 day
          }
        });
        logRequest(method, fullPath, 200, performance.now() - startTime);
        return response;
      }

      // Try to read from DB cache
      const [row] = await sql`
        SELECT url, content, content_type FROM icons
        WHERE namespace = ${parsedImage.namespace}
        LIMIT 1
      `.values();

      if (row) {
        if (row[0] === null) {
          // row[0] is url - we've cached that this image doesn't exist
          response = new Response(null, { status: 404 });
          logRequest(method, fullPath, 404, performance.now() - startTime);
          return response;
        }
        if (row[1]) {
          // row[1] is content - serve from cache
          response = new Response(row[1], {
            headers: {
              "Content-Type": row[2] ?? "image/png",
              // cache for one day and serve stale for 7 days
              "Cache-Control":
                "public, max-age=86400, stale-while-revalidate=604800"
            }
          });
          logRequest(method, fullPath, 200, performance.now() - startTime);
          return response;
        }
      }

      // Scrape Docker Hub
      console.log(
        `${colors.magenta}[SCRAPING]${colors.reset} Starting scrape for ${colors.bright}${parsedImage.namespace}/${parsedImage.repository}${colors.reset}`
      );
      const dockerHubURL = `https://hub.docker.com/r/${parsedImage.namespace}/${parsedImage.repository}`;
      const browser = await chromium.launch();
      const page = await browser.newPage();
      const res = await page.goto(dockerHubURL);

      let imageSrc: string | null = null;
      let message = "Not found";

      if (res?.status() === 200) {
        try {
          const el = await page.waitForSelector(
            '[data-testid="repository-logo"]',
            { timeout: 5000 }
          );
          imageSrc = await el.getAttribute("src");
          console.log(
            `${colors.magenta}[SCRAPING]${colors.reset} ${colors.green}Found logo URL:${colors.reset} ${imageSrc}`
          );
        } catch {
          message = `Page ${dockerHubURL} does not have an associated image`;
          console.log(
            `${colors.magenta}[SCRAPING]${colors.reset} ${colors.yellow}No logo found on page${colors.reset}`
          );
        }
      } else {
        message = `Image \`${parsedImage.namespace}/${parsedImage.repository}\` does not exist on Docker Hub`;
        console.log(
          `${colors.magenta}[SCRAPING]${colors.reset} ${colors.red}Docker Hub returned status ${res?.status()}${colors.reset}`
        );
      }

      await browser.close();

      if (!imageSrc) {
        await sql`
          INSERT INTO icons (namespace, url, content, content_type)
          VALUES (${parsedImage.namespace}, NULL, NULL, NULL)
          ON CONFLICT (namespace) DO UPDATE SET url = NULL
        `;
        response = Response.json({ message }, { status: 404 });
        logRequest(method, fullPath, 404, performance.now() - startTime);
        return response;
      }

      // Fetch actual image
      console.log(
        `${colors.cyan}[FETCH]${colors.reset} Downloading image from ${colors.bright}${imageSrc}${colors.reset}`
      );
      const fresh = await fetch(imageSrc);
      if (!fresh.ok) {
        response = Response.json(
          { message: "failed to fetch logo" },
          { status: 502 }
        );
        logRequest(method, fullPath, 502, performance.now() - startTime);
        return response;
      }

      const buf = Buffer.from(await fresh.arrayBuffer());
      const contentType = fresh.headers.get("content-type") ?? "image/png";

      // Store in DB
      await sql`
        INSERT INTO icons (namespace, url, content, content_type)
        VALUES (${parsedImage.namespace}, ${imageSrc}, ${buf}, ${contentType})
        ON CONFLICT (namespace) DO UPDATE SET
          url = excluded.url,
          content = excluded.content,
          content_type = excluded.content_type,
          updated_at = NOW()
      `;
      console.log(
        `${colors.green}[CACHE]${colors.reset} ${colors.bright}Stored${colors.reset} ${colors.cyan}${parsedImage.namespace}${colors.reset} logo in database`
      );

      // Return with cache headers
      response = new Response(buf, {
        headers: {
          "Content-Type": contentType,
          // cache for one day and serve stale for 7 days
          "Cache-Control":
            "public, max-age=86400, stale-while-revalidate=604800"
        }
      });
      logRequest(method, fullPath, 200, performance.now() - startTime);
      return response;
    } catch (error) {
      console.error(
        `${colors.red}${colors.bright}[ERROR]${colors.reset} ${colors.red}Request failed: ${error}${colors.reset}`
      );
      response = Response.json(
        { message: "Internal server error" },
        { status: 500 }
      );
      logRequest(method, fullPath, 500, performance.now() - startTime);
      return response;
    }
  }
});

console.log(
  `${colors.green}${colors.bright}✓${colors.reset} Server listening on ${colors.cyan}${colors.bright}${server.url}${colors.reset}`
);
console.log(
  `${colors.gray}[${new Date().toISOString()}]${colors.reset} ${colors.green}Server started successfully${colors.reset}`
);

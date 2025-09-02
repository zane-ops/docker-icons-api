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
    if (req.method !== "GET") {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: {
          Allow: "GET",
          "Content-Type": "text/plain"
        }
      });
    }

    const url = new URL(req.url);

    if (url.pathname === "/health") {
      const res = await sql`SELECT true`.values();
      return Response.json({ ok: res[0][0] });
    }

    const regex =
      /^(?:([a-z0-9]+(?:[_-][a-z0-9]+)*)\/)?([a-z0-9]+(?:[_-][a-z0-9]+)*)\.png$/;

    if (!url.pathname.substring(1).match(regex)) {
      return Response.json({ message: "page not found" }, { status: 404 });
    }

    const image = url.pathname.substring(1);

    const parsedImage = parseDockerHubImage(image);
    if (!parsedImage) {
      return Response.json(
        { message: "the image is not a valid docker hub image" },
        { status: 400 }
      );
    }

    // Official dockerhub images → fixed URL
    if (!parsedImage.namespace || parsedImage.namespace === "library") {
      const libUrl = `https://hub.docker.com/api/media/repos_logo/v1/library%2F${parsedImage.repository}?type=logo`;
      const fresh = await fetch(libUrl);
      return new Response(await fresh.arrayBuffer(), {
        headers: {
          "Content-Type": fresh.headers.get("content-type") ?? "image/png",
          "Cache-Control": "public, max-age=86400" // 1 day
        }
      });
    }
    // Try to read from DB cache
    const [row] = await sql`
    SELECT url, content, content_type FROM icons
    WHERE namespace = ${parsedImage.namespace}
    LIMIT 1
  `.values();

    if (row) {
      if (row[0] === null) {
        // row[0] is url
        return new Response(null, { status: 404 });
      }
      if (row[1]) {
        // row[1] is content
        return new Response(row[1], {
          headers: {
            "Content-Type": row[2] ?? "image/png",
            // cache for one day and serve stale for 7 days
            "Cache-Control":
              "public, max-age=86400, stale-while-revalidate=604800"
          }
        });
      }
    }

    // Scrape Docker Hub
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
      } catch {
        message = `Page ${dockerHubURL} does not have an associated image`;
      }
    } else {
      message = `Image \`${parsedImage.namespace}/${parsedImage.repository}\` does not exist on Docker Hub`;
    }

    await browser.close();

    if (!imageSrc) {
      await sql`
      INSERT INTO icons (namespace, url, content, content_type)
      VALUES (${parsedImage.namespace}, NULL, NULL, NULL)
      ON CONFLICT (namespace) DO UPDATE SET url = NULL
    `;
      return Response.json({ message }, { status: 404 });
    }

    // Fetch actual image
    const fresh = await fetch(imageSrc);
    if (!fresh.ok) {
      return Response.json(
        { message: "failed to fetch logo" },
        { status: 502 }
      );
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

    // Return with cache headers
    return new Response(buf, {
      headers: {
        "Content-Type": contentType,
        // cache for one day and serve stale for 7 days
        "Cache-Control": "public, max-age=86400, stale-while-revalidate=604800"
      }
    });
  }
});

console.log(`Listening on ${server.url}`);

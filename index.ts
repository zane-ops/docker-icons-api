import { Database } from "bun:sqlite";
import { chromium } from "playwright";

function parseDockerHubImage(
  image: string
): { namespace: string | null; repository: string } | null {
  const regex =
    /^(?:([a-z0-9]+(?:[._-][a-z0-9]+)*)\/)?([a-z0-9]+(?:[._-][a-z0-9]+)*)$/;
  const match = image.match(regex);

  if (!match) return null;

  const [, namespace, repository] = match;
  return {
    namespace: namespace ?? null, // root images have no namespace
    // @ts-expect-error
    repository
  };
}

const server = Bun.serve({
  port: 8936,
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

    using db = new Database("db.sqlite", { create: true, strict: true });
    db.run(`
  CREATE TABLE IF NOT EXISTS icons (
    namespace TEXT PRIMARY KEY,
    url TEXT
  )
`);

    const url = new URL(req.url);
    const image = url.searchParams.get("image");

    if (!image) {
      return Response.json(
        {
          message: "`image` parameter is required"
        },
        { status: 400 }
      );
    }

    const parsedImage = parseDockerHubImage(image);

    if (!parsedImage) {
      return Response.json(
        {
          message: "the image is not a valid docker hub image"
        },
        { status: 400 }
      );
    }

    if (!parsedImage.namespace || parsedImage.namespace === "library") {
      return fetch(
        `https://raw.githubusercontent.com/docker-library/docs/refs/heads/master/${parsedImage.repository}/logo.png`
      );
    }

    // Check DB for existing thumbnail
    const existingThumbnail = db
      .query<{ url: string }, { namespace: string }>(
        "SELECT url FROM icons WHERE namespace = $namespace LIMIT 1"
      )
      .get({
        namespace: parsedImage.namespace
      });

    if (existingThumbnail) return fetch(existingThumbnail.url);

    const dockerHubURL = `https://hub.docker.com/r/${parsedImage.namespace}/${parsedImage.repository}`;

    const browser = await chromium.launch();
    const page = await browser.newPage();
    const res = await page.goto(dockerHubURL);

    let imageSrc: string | null = null;
    let message = "Not found";

    const saveStmt = db.query<void, { namespace: string; url: string | null }>(
      "INSERT OR IGNORE INTO icons (namespace, url) VALUES ($namespace, $url)"
    );

    if (res?.status() === 200) {
      const el = await page.waitForSelector('[data-testid="repository-logo"]', {
        timeout: 5_000
      });
      if (el) {
        imageSrc = await el.getAttribute("src");
      } else {
        message = `Page ${dockerHubURL} does not have an associated image`;
        saveStmt.all({
          namespace: parsedImage.namespace,
          url: null
        });
      }
    } else {
      message = `Image \`${parsedImage.namespace}/${parsedImage.repository}\` does not exist on Docker Hub`;
    }

    await browser.close();

    if (!imageSrc) {
      return Response.json(
        { message },
        {
          status: 404
        }
      );
    }

    saveStmt.all({
      namespace: parsedImage.namespace,
      url: imageSrc
    });

    return fetch(imageSrc);
  }
});

console.log(`Listening on ${server.url}`);

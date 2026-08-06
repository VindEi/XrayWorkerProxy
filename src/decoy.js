export const DECOY_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Coming Soon</title>
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: -apple-system, sans-serif; max-width: 640px; margin: 80px auto; padding: 0 20px; color: #222;">
  <h1>Coming Soon :)</h1>
  <p>This site is under construction. Please check back later.</p>
</body>
</html>`;

export function serveDecoy() {
  return new Response(DECOY_HTML, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=UTF-8",
      "Cache-Control": "public, max-age=3600",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

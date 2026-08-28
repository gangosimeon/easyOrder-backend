export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const key = searchParams.get('key') ?? '';
  const expected = process.env.SWAGGER_ACCESS_KEY;

  if (!expected || key !== expected) {
    return new Response('Not found', { status: 404 });
  }

  const html = `<!DOCTYPE html>
<html lang="fr">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Burkina Shop — API Docs</title>
    <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css" />
    <style>
      body { margin: 0; background: #fafafa; }
    </style>
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
    <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-standalone-preset.js"></script>
    <script>
      window.onload = function () {
        SwaggerUIBundle({
          url: '/api/swagger?key=${encodeURIComponent(key)}',
          dom_id: '#swagger-ui',
          presets: [SwaggerUIBundle.presets.apis, SwaggerUIStandalonePreset],
          layout: 'StandaloneLayout',
          persistAuthorization: true,
          docExpansion: 'list',
          defaultModelsExpandDepth: 1,
          filter: true,
        });
      };
    </script>
  </body>
</html>`;

  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

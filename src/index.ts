import { Hono } from 'hono';
import { cors } from 'hono/cors';

type Bindings = {
  STORAGE_BUCKET: R2Bucket;
  INTERNAL_SERVICE_SECRET: string;
};

const app = new Hono<{ Bindings: Bindings }>();

app.use(
  '*',
  cors({
    origin: (origin) => origin || '*',
    allowMethods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowHeaders: [
      'Content-Type', 
      'Authorization', 
      'X-Internal-Secret',
      'X-File-Type', 
      'X-Target-Id', 
      'X-Filename'
    ],
    exposeHeaders: ['Content-Length'],
    maxAge: 600,
    credentials: true,
  })
);

// Subida directa por stream (Stream directo al Bucket sin cargar todo en RAM)
app.put('/api/v1/storage/upload', async (c) => {
  const tipo = c.req.header('X-File-Type') as 'informe' | 'dataset';
  const targetId = c.req.header('X-Target-Id');
  const filename = c.req.header('X-Filename');
  const contentType = c.req.header('Content-Type');
  const contentLength = Number(c.req.header('Content-Length') || 0);

  // 1. Validar parámetros mínimos
  if (!tipo || !targetId || !filename || !contentType || !RULES[tipo]) {
    return c.json({ success: false, error: 'Cabeceras requeridas: X-File-Type, X-Target-Id, X-Filename, Content-Type' }, 400);
  }

  // 2. Validar tamaño y tipo MIME
  const rule = RULES[tipo];
  if (contentLength > rule.maxBytes) {
    return c.json({ success: false, error: `El archivo supera el límite de ${rule.maxBytes / (1024 * 1024)}MB` }, 400);
  }
  if (!rule.mimes.includes(contentType)) {
    return c.json({ success: false, error: `Tipo MIME no permitido: ${contentType}` }, 400);
  }

  // 3. Sanitizar y armar file key
  const cleanFilename = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
  const fileKey = `\({tipo}s/\){targetId}/\({Date.now()}_\){cleanFilename}`;

  // 4. Guardar directamente en R2 con el binding nativo
  await c.env.STORAGE_BUCKET.put(fileKey, c.req.raw.body, {
    httpMetadata: { contentType },
  });

  return c.json({
    success: true,
    data: {
      file_key: fileKey,
      filename: cleanFilename,
      bytes: contentLength,
    },
    message: 'Archivo almacenado exitosamente en R2',
  }, 201);
});

// Descarga / visualización directa
app.get('/api/v1/storage/file/*', async (c) => {
  const fileKey = c.req.path.replace('/api/v1/storage/file/', '');
  const object = await c.env.STORAGE_BUCKET.get(fileKey);

  if (!object) {
    return c.json({ success: false, error: 'Archivo no encontrado' }, 404);
  }

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);

  return new Response(object.body, { headers });
});

export default app;
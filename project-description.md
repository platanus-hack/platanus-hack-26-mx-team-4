# MercadoLimpio

**Comprá mejor en MercadoLibre: resultados sin sesgo de publicidad y opiniones resumidas con IA.**

## El problema

Comprar en MercadoLibre se volvió una pelea contra el ruido. Los primeros resultados están dominados por publicidad y posicionamiento pago, no necesariamente por la mejor relación calidad-precio. Y para saber si un producto vale la pena, hay que leerse decenas de opiniones dispersas o buscar análisis externos producto por producto. El resultado: decisiones peores y más lentas.

## La solución

**MercadoLimpio** es una extensión de Chrome (Manifest V3) que actúa como una capa de IA sobre la experiencia de compra, sin reemplazar a MercadoLibre. Tiene dos pilares:

### Pilar 1 - Reordenamiento limpio del listado
Reordena las tarjetas de la página de resultados usando **solo señales visibles** (precio, reputación, ventas, calificación), bajando el peso de la publicidad. Es un *toggle*: lo prendés y ves el listado ordenado por calidad real; lo apagás y vuelve al orden original. **No hace ninguna llamada de red** - solo reordena el DOM de la página.

### Pilar 2 - Resumen de opiniones y análisis externos con IA
En la página de producto, resume opiniones públicas de MercadoLibre con IA (Gemini 2.5 Flash) en tres bloques claros: **puntos a favor**, **puntos en contra** y un **veredicto**. Además, cuando existe una coincidencia confiable, permite consultar análisis técnicos de **RTINGS** para complementar las opiniones de compradores con una mirada experta sobre aspectos como batería, cancelación de ruido, comodidad, uso en oficina o viajes.

## Cómo funciona (y por qué es seguro)

- La extensión **nunca** habla directamente con el modelo de IA. Envía únicamente texto público de opiniones o referencias de producto a un proxy propio (función serverless en Vercel), que es el único que tiene la API key.
- La **API key vive solo del lado del servidor**: nunca está en la extensión, ni en el código cliente, ni en las peticiones del navegador hacia Gemini.
- El proxy valida y acota cada pedido, consulta fuentes externas del lado servidor cuando corresponde y devuelve un resumen con estructura fija.
- Si la IA o una fuente externa no está disponible, la tarjeta muestra un estado claro en vez de romperse.

## Stack

- **Extensión**: TypeScript + Vite + crxjs (Chrome MV3, permission-light)
- **Backend**: función serverless en Vercel + Gemini 2.5 Flash
- **Fuentes**: opiniones públicas de MercadoLibre + análisis técnicos de RTINGS cuando hay match confiable
- **Calidad**: suite automatizada para ranking, resumen, cache, proxy e integración RTINGS

## Track

Legacy - modernizamos la experiencia de compra sobre un producto legacy (MercadoLibre) sin pedirle permiso ni reemplazarlo: una capa de IA que el usuario controla.

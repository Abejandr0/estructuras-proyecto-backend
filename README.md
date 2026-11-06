# MiniGit

MiniGit es un control de versiones local en TypeScript, organizado como monorepo. El motor almacena blobs, árboles y commits identificados con SHA-1 de `tipo tamaño\0contenido` y comprimidos con zlib en `.minigit/objects`; mantiene staging en `index`, ramas en `refs/heads`, HEAD simbólico y un reflog básico. El objeto vuelve a verificarse por hash y tamaño al leerlo.

## Inicio

```sh
npm install
npm run build
npm test
npm run dev:server # en un repositorio inicializado, puerto 4179
npm run dev:web    # Vite
```

CLI: `minigit init`, `add`, `commit`, `status`, `log`, `branch`, `checkout`, `serve`. Para ejecutar desde el workspace: `node packages/cli/dist/index.js <comando>`.

## Arquitectura y persistencia

- `packages/core`: estructuras propias y motor de objetos/refs.
- `packages/cli`: CLI sobre directorios reales.
- `packages/server`: HTTP, WebSocket de eventos, endpoints de repositorio y proveedor IA (heurístico o API compatible OpenAI mediante `OPENAI_API_KEY`).
- `apps/web`: interfaz React/Vite en español, grafo SVG, terminal, estado del repo e inspector de buckets.

`.minigit/index` es JSON con ruta, modo y hash de blob. Árboles y commits son JSON UTF-8 dentro de objetos comprimidos; los árboles contienen entradas ordenadas con nombre, modo, tipo y hash. HEAD contiene `ref: refs/heads/main`. El reflog usa registros de hash anterior/nuevo, autor y mensaje.

## Estructuras

| Estructura | Uso | Complejidad |
|---|---|---|
| DynamicArray | Colecciones indexadas | acceso O(1), inserción amortizada O(1), quitar O(n) |
| Stack | Deshacer/rehacer y stash (base) | push/pop O(1) |
| Queue | BFS y tareas IA | enqueue/dequeue amortizado O(1) |
| NaryTree | Árbol de directorios | recorrido O(n) |
| Graph | DAG de commits | BFS/topológico O(V+E) |
| SinglyLinkedList | Historial lineal | append O(1), búsqueda O(n) |
| DoublyLinkedList | Reflog y LRU | insertar/quitar por nodo O(1) |
| CircularDoublyLinkedList | Rotación de ramas/stashes | rotación O(1) |
| HashTable | Índice de objetos | promedio O(1), peor O(n) |
| Trie | Autocompletado | O(k) por prefijo |
| MinHeap | Prioridad | push/pop O(log n), peek O(1) |
| BloomFilter | Consulta probable de existencia | O(k), puede tener falsos positivos |
| LRUCache | Caché de lectura | promedio O(1) |

La regla del curso prohíbe `Map`, `Set` y librerías de estructuras de datos en core; las colecciones del motor usan implementaciones propias. La interfaz y el servidor pueden usar colecciones nativas.

## Estado de alcance

Esta entrega cubre el almacenamiento local inicial, staging, commits lineales, ramas, checkout, status, log, API local, eventos de archivos e IA inicial. Merge con conflictos, undo/redo y stash/reset/revert, sincronización remota completa (clone/push/pull con negociación de objetos), revisiones IA con cola persistente/reintentos, edición de archivos y pruebas de integración del servidor aún requieren implementación. No se deben usar los comandos stub como si ya fueran compatibles con Git. Los objetos son un formato educativo propio y no intercambiables con Git.

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

CLI: `minigit init`, `add`, `commit`, `status`, `log`, `branch`, `checkout`, `merge`, `stash`, `reset`, `revert`, `serve`, `clone`, `push`, `pull`. Para remoto, inicia `minigit serve` dentro del repo del servidor y usa la URL HTTP en clone/push/pull.

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

Esta entrega cubre almacenamiento local, ramas, merge con marcadores de conflicto, stash, reset, revert, sincronización remota por HTTP, API local, eventos de archivos, IA heurística y adaptador de revisión por API, y una interfaz de exploración. La transferencia calcula objetos faltantes usando hashes conocidos. El backend de IA aún no implementa reintentos ni un límite configurable de concurrencia; la cola y sus estados solo existen durante la solicitud. El editor no guarda cambios y el panel de diff y el grafo todavía son vistas iniciales. `reset --hard` reescribe el árbol de trabajo y debe usarse con cuidado. Los objetos y el protocolo son educativos y no intercambiables con Git. Benchmarks básicos: `npm run bench`.

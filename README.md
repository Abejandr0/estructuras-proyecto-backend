# MiniGit

MiniGit es un control de versiones local en TypeScript, organizado como monorepo. El motor almacena blobs, árboles y commits identificados con SHA-1 de `tipo tamaño\0contenido` y comprimidos con zlib en `.minigit/objects`; mantiene staging en `index`, ramas en `refs/heads`, HEAD simbólico y un reflog básico. El objeto vuelve a verificarse por hash y tamaño al leerlo.

## Inicio

```sh
npm install
npm run build
npm test
npm run dev:server # inicializa .minigit en la raíz si hace falta, puerto 4179
npm run dev:web    # Vite
```

Abre `http://localhost:5173`. El servidor local escucha en `127.0.0.1:4179`. Para servir otro repositorio usa `MINIGIT_REPO=/ruta/al/repo npm run dev:server`. La IA funciona en modo heurístico sin configuración. El proveedor externo solo se habilita cuando están definidas `AI_ALLOW_NETWORK=true` y `OPENAI_API_KEY`; así los diffs no salen del equipo por accidente.

CLI: `minigit init`, `add`, `commit`, `status`, `log`, `branch`, `checkout`, `merge`, `stash`, `reset`, `revert`, `serve`, `clone`, `push`, `pull`. Para remoto, inicia `minigit serve` dentro del repo del servidor y usa la URL HTTP en clone/push/pull.

## Arquitectura y persistencia

- `packages/core`: estructuras propias y motor de objetos/refs.
- `packages/cli`: CLI sobre directorios reales.
- `packages/server`: HTTP, WebSocket de eventos, endpoints de repositorio y proveedor IA (heurístico o API compatible OpenAI mediante `OPENAI_API_KEY`).
- `apps/web`: interfaz React/Vite en español, grafo SVG, terminal, estado del repo e inspector de buckets.

`.minigit/index` es JSON con ruta, modo y hash de blob. Árboles y commits son JSON UTF-8 dentro de objetos comprimidos; los árboles contienen entradas ordenadas con nombre, modo, tipo y hash. HEAD contiene `ref: refs/heads/main`. El reflog usa registros de hash anterior/nuevo, autor y mensaje.

## Estructuras

| Estructura | Uso actual / estado | Complejidad |
|---|---|---|
| DynamicArray | Colecciones indexadas y rutas de recorrido | acceso O(1), inserción amortizada O(1), quitar O(n) |
| Stack | Almacenamiento de la pila persistida de stashes | push/pop O(1) |
| Queue | BFS de objetos alcanzables y recorridos del motor | enqueue/dequeue amortizado O(1) |
| NaryTree | Implementada; falta conectarla al árbol de archivos | recorrido O(n) |
| Graph | Implementado; el motor recorre el DAG con BFS/Queue | BFS/topológico O(V+E) |
| SinglyLinkedList | Implementada; historial lineal aún no la usa | append O(1), búsqueda O(n) |
| DoublyLinkedList | Base de la lista usada por LRUCache | insertar/quitar por nodo O(1) |
| CircularDoublyLinkedList | Implementada; falta conectarla al carrusel de ramas/stashes | rotación O(1) |
| HashTable | Índice en memoria de objetos leídos/escritos | promedio O(1), peor O(n) |
| Trie | Implementado; autocompletado aún no integrado | O(k) por prefijo |
| MinHeap | Implementado; top-K aún no integrado | push/pop O(log n), peek O(1) |
| BloomFilter | Negociación remota de objetos junto con hashes exactos | O(k), puede tener falsos positivos |
| LRUCache | Implementado; falta conectarlo a lecturas y diffs del motor | promedio O(1) |

La regla del curso prohíbe `Map`, `Set` y librerías de estructuras de datos en core; las colecciones del motor usan implementaciones propias. La interfaz y el servidor pueden usar colecciones nativas.

## Estado de alcance

Esta entrega cubre almacenamiento local, ramas, merge con marcadores de conflicto, stash, reset, revert, sincronización remota por HTTP, API local, eventos de archivos, IA heurística y adaptador de revisión por API, y una interfaz de exploración con diff lado a lado. La cola de IA conserva estados en memoria, aplica reintentos y limita la concurrencia mediante `AI_CONCURRENCY`. La transferencia recorre el DAG alcanzable desde las ramas, usa un Bloom filter junto con los hashes conocidos y envía los objetos que faltan. Los hashes exactos evitan perder objetos por falsos positivos del filtro. El editor todavía no guarda cambios y el trazado del grafo usa un solo carril visual. `reset --hard` reescribe el árbol de trabajo y debe usarse con cuidado. Los objetos y el protocolo son educativos y no intercambiables con Git. Benchmarks básicos: `npm run bench`.

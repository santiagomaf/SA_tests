# Pruebas de concepto: sala de espera y último asiento

Dos servicios mínimos del informe "Venta de Entradas" y dos tests de carga que comprueban, con números, los escenarios de calidad que justifican su diseño.

| Test | Servicio | Escenario / ADR | Qué demuestra |
|---|---|---|---|
| T1 Pico en la fila | Sala de espera | EC-02 / ADR-02 (flujos S1, S2, S3) | La fila absorbe una ráfaga de 200.000 ingresos y admite como máximo 500 por minuto, en orden de llegada y sin errores |
| T2 Último asiento | API de ventas (solo reservas) | EC-01 / ADR-01 (flujo F1) | De 50 compradores que disputan un asiento, exactamente 1 lo obtiene. La versión ingenua, en cambio, sobrevende |
| T3 Entradas agotadas | Ambos | Límite de 25.000 entradas por evento | Se venden exactamente 25.000; al venderse la última, la fila se descarta y todos los que esperaban reciben el aviso de agotado |

No se implementan pagos, RabbitMQ, PostgreSQL, emisión de QR ni frontend.

## Cómo correrlo

Requiere Docker y Python 3. Nada más se instala en el equipo.

```bash
./stack.sh up             # Redis, 2 réplicas de cada servicio y Nginx
# Dashboard en vivo: http://localhost:8090

cd loadtest
./run.sh queue low        # T1 con 2.000 ingresos        (~5 min)
./run.sh queue high       # T1 con 200.000 ingresos      (~5 min)
./run.sh seat safe        # T2: 50 compradores, 1 asiento
./run.sh seat naive       # T2 contra la versión que sobrevende
./run.sh seat safe high   # T2: 5.000 compradores, 100 asientos
./run.sh soldout low      # T3: 2.000 compradores, 100 entradas      (~10 s)
./run.sh soldout high     # T3: 200.000 compradores, 25.000 entradas (~40 s)
```

Cada corrida usa un evento nuevo, imprime los criterios con PASS o FAIL y deja la salida en `loadtest/results/`. Si el puerto 8090 está ocupado: `PORT=8095 ./stack.sh up` y `PORT=8095 ./run.sh ...`. Al terminar: `./stack.sh down`.

Para la prueba de caída de una réplica, durante `./run.sh queue low` ejecutar `docker stop poc-wr-2`.

`stack.sh` usa solo `docker`. Quien tenga Docker Compose puede usar `docker compose up -d --build`, que levanta lo mismo (ahí la réplica se detiene con `docker compose stop waiting-room-2`).

## Qué hay adentro

```
stack.sh             levanta y baja el entorno sin Compose
docker-compose.yml   redis, keygen, waiting-room-1/2, sales-api-1/2, nginx
nginx.conf           balanceador frente a las réplicas
waiting-room/        server.js, join.lua (S1), admit.lua (S2), public/index.html (dashboard)
sales-api/           server.js (/reserve y /reserve-naive)
loadtest/            queue_spike.js, last_seat.js, soldout.js (k6), run.sh, verify.py, results/
```

Cómo calza con el informe:

| Informe | Implementación |
|---|---|
| Fila en un Sorted Set de Redis, `ZADD NX` con la hora de llegada (S1) | `waiting-room/join.lua`. La hora la pone Redis, así las réplicas comparten reloj |
| Despachador que admite a una tasa configurable por evento (S2) | `waiting-room/admit.lua`, ejecutado cada segundo por cada réplica. El cupo se calcula dentro de Redis, por eso dos réplicas no admiten el doble |
| Token firmado y de corta vigencia, recuperable por consulta de estado (S2, S3) | JWS con ECDSA P-256. La sala firma con la clave privada; la API de ventas valida solo con la pública, sin llamar a la sala |
| `SET seat:{evento}:{asiento} {comprador} NX PX 600000` (F1) | `sales-api/server.js`, ruta `/reserve` |
| Reintento idempotente del mismo comprador (F4) | `/reserve` responde 200 si el asiento ya es suyo |
| API stateless detrás de un balanceador (ADR-04) | 2 réplicas de cada servicio detrás de Nginx; todo el estado está en Redis |

Simplificaciones: el comprador se identifica con un ID en la solicitud (no hay sesiones ni login) y `/admin/*` no tiene autenticación.

## T1: pico en la fila

**Modelo de llegada.** Los ingresos no se reparten parejo en 5 minutos. El test los genera como ráfaga: la tasa sube al máximo en 2 s, se mantiene 25 s, y luego cae a un goteo de rezagados hasta completar los 5 minutos. Cerca del 70 % de los ingresos ocurre en los primeros 30 s. Además, una muestra de compradores consulta su posición cada 3 a 5 s hasta ser admitida, y recarga la página una vez.

En la escala alta ingresan los 200.000 compradores, pero solo 2.000 hacen consultas periódicas: un notebook no sostiene 200.000 clientes simulados consultando a la vez.

**Criterios** (los revisa `verify.py` con lo que midió k6 y con el registro de admisiones del servidor):

1. p95 menor a 2 s al ingresar y al consultar la posición.
2. 0 % de errores 5xx.
3. Nunca más de 500 admitidos en una ventana de 60 s.
4. Se admite en orden de llegada y nadie que sigue en la fila llegó antes que un admitido.
5. Ingresos = en fila + admitidos (nadie se pierde).
6. Reingresar no cambia la posición.

**Resultados** (notebook con 16 hilos y 12 GB, todo en la misma máquina, 11-11-2026):

| | Baja escala | Alta escala |
|---|---|---|
| Ingresos únicos | 2.135 | 199.277 |
| Ingresos por segundo durante la ráfaga | ~90 | ~5.050 sostenidos, 8.363 en el peor segundo |
| Ingresos en los primeros 30 s | 70 % | 73 % |
| Solicitudes HTTP | 4.917 | 335.715 |
| p95 ingreso / consulta | 3,7 ms / 3,5 ms | 2,7 ms / 1,6 ms |
| Latencia máxima | 43 ms | 104 ms |
| Errores 5xx | 0 | 0 |
| Máximo de admitidos en 60 s (tope 500) | 500 | 500 |
| Admitidos / quedan en la fila al terminar | 2.135 / 0 | 2.446 / 196.831 |
| Criterios | 6 de 6 | 6 de 6 |

Con una réplica de la sala detenida a los 40 s de la corrida de baja escala, el resultado fue el mismo: 0 errores 5xx, tope de 500 respetado y nadie perdido (`loadtest/results/kill-run.log`).

## T2: último asiento

Los compradores pasan primero por la sala de espera real para obtener su token. Luego todos envían la reserva al mismo tiempo.

| Variante | Carga | Resultado |
|---|---|---|
| `safe` | 50 compradores, 1 asiento | 1× 201 y 49× 409; p95 68 ms, máximo 73 ms |
| `naive` | 50 compradores, 1 asiento | 15 compradores recibieron confirmación del mismo asiento |
| `safe high` | 5.000 compradores, 100 asientos | 100× 201 y 4.900× 409, un ganador por asiento; p95 entre 127 y 695 ms |

`/reserve-naive` lee si el asiento está libre y después lo escribe; entre ambos pasos otros compradores también lo ven libre. La cantidad de "ganadores" varía en cada corrida, pero siempre es mayor que 1. `/reserve` hace una sola operación atómica y el resultado es siempre 1.

En `safe high` el p95 depende de si los servicios están recién iniciados: la primera corrida tras levantarlos dio 695 ms y la siguiente 127 ms. El test también comprueba que sin token, con la firma adulterada o con un token de otro evento la respuesta es 401.

## T3: entradas agotadas

Cada evento tiene un stock de entradas: 25.000 por defecto, o el que se fije con `POST /seats/{evento}/stock`. Funciona así:

1. `/reserve` revisa el stock, reserva el asiento (`SET NX PX`) y suma la venta en una sola operación atómica en Redis. Con el stock agotado responde 410.
2. Al venderse la última entrada, la API de ventas deja la marca `soldout:{evento}`.
3. El despachador de la sala ve la marca en su siguiente ciclo (1 s como máximo), descarta la fila completa y deja de admitir.
4. Desde ese momento, ingresar a la fila o consultar la posición devuelve `sold_out`.

En el test, cada comprador entra a la fila, compra un asiento distinto al ser admitido y termina con una compra o con el aviso de agotado. Para que la corrida dure segundos y no 50 minutos, la tasa de admisión se sube a 60.000 por minuto en la escala alta (1.200 en la baja); se cambia con `ADMIT_PER_MIN`.

| | Baja escala | Alta escala |
|---|---|---|
| Compradores / entradas | 2.000 / 100 | 200.000 / 25.000 |
| Compraron (201) | 100 | 25.000 |
| Admitidos que ya no alcanzaron entrada (410) | 6 | 85 |
| Avisados de agotado en la sala | 1.894 | 174.915 |
| Descartados de la fila al agotarse | 1.883 | 174.076 |
| Solicitudes HTTP / errores 5xx | 23.730 / 0 | 751.400 / 0 |
| Duración | 8 s | 35 s |
| Criterios | 7 de 7 | 7 de 7 |

Se admite a algunas personas más que el stock (25.924 en la escala alta) porque la sala sigue admitiendo hasta que ve la marca. Esas personas reciben el aviso de agotado, nunca una venta de más.

Simplificación: como no hay pagos, la reserva cuenta como venta. En el sistema real, una reserva que vence sin pago devolvería la entrada al stock.

## Corrección propuesta para el informe

La sección 12.1 dice que 200.000 usuarios en 5 minutos "equivalen a unas 667 solicitudes por segundo". Eso supone una llegada uniforme, que es lo que observó el profesor. Texto sugerido:

> Los 200.000 usuarios no llegan repartidos de forma pareja: la mayoría ingresa en los primeros segundos tras abrirse la venta. El promedio de 667 solicitudes por segundo subestima el pico real. En la prueba de concepto se modeló la llegada como una ráfaga, con cerca del 70 % de los ingresos en los primeros 30 segundos, lo que equivale a unas 5.000 solicitudes por segundo sostenidas. Con esa carga, la sala de espera respondió con un p95 de 2,7 ms y sin errores, porque cada ingreso es una única escritura en Redis que no toca la API de ventas ni PostgreSQL.

El mismo supuesto aparece en la medida de EC-02 ("200.000 usuarios intentan ingresar durante los primeros 5 minutos"): conviene precisar ahí la forma de la llegada.

El cálculo de las 6,7 horas de fila a 500 admisiones por minuto (ADR-02 y flujo S2) sigue siendo correcto y la prueba lo confirma: tras 5 minutos quedaban 196.831 personas esperando.

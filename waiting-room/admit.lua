-- Flujo S2: admite el siguiente lote, de forma atómica.
-- KEYS: 1 queue:{e}  2 admitlog:{e}  3 admitlast:{e}  4 arrivals:{e}  5 events
--       6 soldout:{e}  7 dropped:{e}
-- ARGV: 1 tasa por minuto  2 TTL de la admisión (s)  3 prefijo admitted:{e}:  4 evento
-- Devuelve {segundo actual, comprador, comprador, ...}.
--
-- Como el cupo se calcula dentro de Redis, varias réplicas pueden ejecutar el
-- despachador a la vez sin admitir de más.
local t = redis.call('TIME')

-- Entradas agotadas (lo marca la API de ventas): se descarta la fila completa
-- y no se admite a nadie más.
if redis.call('EXISTS', KEYS[6]) == 1 then
  local left = redis.call('ZCARD', KEYS[1])
  if left > 0 then
    redis.call('INCRBY', KEYS[7], left)
    redis.call('UNLINK', KEYS[1])
  end
  redis.call('SREM', KEYS[5], ARGV[4])
  return { t[1] }
end

local now = t[1] * 1000000 + t[2]
local rate = tonumber(ARGV[1])
local interval = 60000000 / rate -- microsegundos entre admisiones

-- Ritmo parejo: se admite lo que corresponde al tiempo transcurrido desde el
-- último lote. Tras una pausa no se acumula más de 1 s de cupo.
local last = tonumber(redis.call('GET', KEYS[3]))
if not last or now - last > 2000000 then
  last = now - 1000000
end
local n = math.floor((now - last) / interval)

-- Tope duro: nunca más de `rate` admisiones en los últimos 60 s.
local used = redis.call('ZCOUNT', KEYS[2], string.format('%.0f', now - 60000000), '+inf')
if n > rate - used then
  n = rate - used
end
if n < 1 then
  return { t[1] }
end

local popped = redis.call('ZPOPMIN', KEYS[1], n) -- los de llegada más antigua
local out = { t[1] }
local nowstr = string.format('%.0f', now)
for i = 1, #popped, 2 do
  local buyer, arrival = popped[i], popped[i + 1]
  redis.call('ZADD', KEYS[2], nowstr, buyer)
  redis.call('HSET', KEYS[4], buyer, arrival)
  local key = ARGV[3] .. buyer
  redis.call('HSET', key, 'arrival', arrival, 'at', t[1])
  redis.call('EXPIRE', key, ARGV[2])
  out[#out + 1] = buyer
end

if #popped / 2 == n then
  last = last + n * interval
else
  last = now -- la fila se vació
end
redis.call('SET', KEYS[3], string.format('%.0f', last))

if redis.call('ZCARD', KEYS[1]) == 0 then
  redis.call('SREM', KEYS[5], ARGV[4])
end
return out

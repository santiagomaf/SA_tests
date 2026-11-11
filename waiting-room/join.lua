-- Flujo S1: ingreso a la fila.
-- KEYS: 1 queue:{e}  2 admitted:{e}:{b}  3 joined:{e}  4 events  5 joinsps:{e}  6 soldout:{e}
-- ARGV: 1 comprador  2 evento
-- Devuelve {posición (base 0), 1 si es un ingreso nuevo}; -1 = ya admitido; -2 = entradas agotadas.
if redis.call('EXISTS', KEYS[6]) == 1 then
  return { -2, 0 }
end
if redis.call('EXISTS', KEYS[2]) == 1 then
  return { -1, 0 }
end

-- La hora de llegada la pone Redis, así todas las réplicas usan el mismo reloj.
local t = redis.call('TIME')
local score = string.format('%.0f', t[1] * 1000000 + t[2])

-- NX: si el comprador recarga o abre otra pestaña conserva su posición original.
local added = redis.call('ZADD', KEYS[1], 'NX', score, ARGV[1])
if added == 1 then
  redis.call('INCR', KEYS[3])
  redis.call('SADD', KEYS[4], ARGV[2])
  redis.call('HINCRBY', KEYS[5], t[1], 1)
end

return { redis.call('ZRANK', KEYS[1], ARGV[1]), added }

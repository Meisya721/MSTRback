# MSTR Backend

Backend Node.js + TypeScript untuk frontend `Website/MSTRProject1`.

## Menjalankan

1. Salin `.env.example` menjadi `.env`, lalu isi konfigurasi MySQL dan MQTT.
2. Jalankan `schema.sql` pada MySQL.
3. Jalankan `npm run dev`.

Server berjalan di `http://localhost:4000`.

## API

- `GET /api/health`
- `GET /api/measurements?limit=50`
- `GET /api/measurements/latest`

Payload MQTT pada topic `mstr/telemetry`:

```json
{"cellId":"cell-01","voltage":1.2,"current":0.04,"power":0.048,"energy":2.4,"timestamp":"2026-09-28T10:00:00.000Z"}
```
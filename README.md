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

# MSTR ESP32 Firmware

Firmware PlatformIO untuk ESP32 + satu sensor Adafruit INA219. ESP32 mengukur satu sesi/substrat pada satu waktu, mengirim telemetry melalui MQTT, dan menahan pembacaan offline di LittleFS.

## Wiring

```text
INA219 VIN+  -> sisi positif/katoda sumber MFC
INA219 VIN-  -> ujung resistor beban
ujung resistor beban -> kembali ke sisi negatif/rangkaian MFC
INA219 SDA   -> ESP32 GPIO 21 (SDA)
INA219 SCL   -> ESP32 GPIO 22 (SCL)
INA219 GND   -> ESP32 GND (ground bersama)
INA219 VCC   -> ESP32 3V3
```

INA219 dipasang **seri** dengan resistor beban. Jangan memasang VIN+ dan VIN- paralel ke sumber. Jika memakai pin I2C lain, ubah `I2C_SDA_PIN` dan `I2C_SCL_PIN` di `include/config.h`.

## Konfigurasi

1. Salin `include/config.example.h` menjadi `include/config.h`.
2. Isi SSID/password WiFi, host/port/user/password broker, dan client ID.
3. Jangan commit kredensial nyata. `config.example.h` hanya berisi placeholder.

Library dikelola oleh `platformio.ini`: Adafruit INA219, PubSubClient, ArduinoJson, dan filesystem LittleFS bawaan core ESP32.

## Kalibrasi INA219

Kode memakai `ina219.setCalibration_16V_400mA()` untuk arus kecil. Konfigurasi ini cocok untuk rentang bus sampai 16 V dan arus sekitar 400 mA dengan shunt bawaan modul. Jika shunt atau resistor beban berbeda, sesuaikan kalibrasi INA219 sesuai nilai shunt dan rentang arus maksimum modul, lalu verifikasi dengan multimeter. Jangan mengubah batas hanya untuk menghilangkan nilai saturasi.

Firmware mengambil 10 sampel INA219 per pembacaan dan merata-ratakannya untuk mengurangi noise. Jumlah sampel dapat diubah lewat `TELEMETRY_SAMPLES`.

## MQTT

Topic yang digunakan:

- `mstr/status`: status perangkat, retained; Last Will mengirim string `offline`, setelah connect mengirim `online`.
- `mstr/cmd`: subscribe command retained dari backend.
- `mstr/telemetry`: publish JSON sesi.
- `mstr/ack`: publish konfirmasi command.

Telemetry:

```json
{"session_id":12,"t":3600,"v":0.512,"i":0.43,"p":0.22}
```

`v` dalam Volt, `i` dalam mA, dan `p` dalam mW. Command yang diterima:

```json
{"action":"start","session_id":12,"interval_s":10}
{"action":"stop","session_id":12}
```

Ack berbentuk JSON dengan `action`, `session_id`, `ok`, dan `t` saat tersedia.

### Resume command retained

Saat boot, state sesi (`active`, `session_id`, `interval_s`, dan `elapsed_seconds`) dimuat dari LittleFS. MQTT subscribe menerima command retained segera setelah connect. Command `start` dengan session ID yang sama melanjutkan `t` dari nilai terakhir yang tersimpan; jika command membawa field `t`, nilainya hanya menjadi fallback dan checkpoint lokal yang lebih besar dipakai. Session ID baru memulai `t` dari field `t` command bila tersedia, atau 0. Jika perangkat mati di antara dua penyimpanan state, pembacaan berikutnya melanjutkan dari checkpoint telemetry terakhir, bukan menebak waktu saat ESP32 mati. Command `stop` disimpan sebagai tidak aktif sehingga retained stop tidak memulai sesi lagi.

## Offline buffer dan reconnect

WiFi dan MQTT di-reconnect otomatis dengan backoff hingga 30 detik. Saat MQTT tidak tersedia, setiap telemetry ditambahkan berurutan ke `/telemetry.ndjson` di LittleFS. Setelah tersambung, firmware mengirim antrean dari baris paling lama ke paling baru, lalu menghapus file hanya setelah semua publish berhasil.

## Upload dan monitor

```bash
cd firmware
pio run
pio run -t upload
pio run -t uploadfs
pio device monitor -b 115200
```

`uploadfs` diperlukan agar LittleFS tersedia pada flash perangkat. Pastikan `include/config.h` sudah berisi konfigurasi lokal sebelum upload.

## Verifikasi MQTT

Dengan broker dan backend aktif, jalankan:

```bash
mosquitto_sub -h 192.168.1.10 -p 1883 -t 'mstr/status' -v
mosquitto_sub -h 192.168.1.10 -p 1883 -t 'mstr/telemetry' -v
mosquitto_sub -h 192.168.1.10 -p 1883 -t 'mstr/ack' -v
```

Kirim command start dari backend atau uji retained command dengan client MQTT yang sesuai. Verifikasi bahwa status berubah ke `online`, telemetry memiliki `session_id/t/v/i/p`, dan ack muncul após `mstr/cmd` diterima.

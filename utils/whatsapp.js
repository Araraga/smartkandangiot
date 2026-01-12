const axios = require("axios");
const dotenv = require("dotenv");
dotenv.config();

/**
 * 1. Fungsi Format Nomor HP
 * Mengubah 0812... menjadi 62812...
 * Mengubah +628... menjadi 628...
 * Agar formatnya seragam di database dan Fonnte.
 */
const formatPhoneNumber = (number) => {
  let formatted = number.toString().trim();

  // Hapus karakter selain angka (spasi, strip, plus)
  formatted = formatted.replace(/\D/g, "");

  // Jika diawali '0', ganti dengan '62'
  if (formatted.startsWith("0")) {
    formatted = "62" + formatted.substring(1);
  }

  return formatted;
};

/**
 * 2. Fungsi Kirim OTP via Fonnte
 */
const sendWhatsappOTP = async (phone, otp) => {
  try {
    const token = process.env.FONNTE_TOKEN;

    // Pesan yang akan diterima user
    const message = `*IoTernak Security*
Kode Verifikasi Anda: *${otp}*

Jangan berikan kode ini kepada siapa pun.
Kode berlaku selama 5 menit.`;

    // Request ke API Fonnte
    const response = await axios.post(
      "https://api.fonnte.com/send",
      {
        target: phone, // Nomor tujuan (sudah diformat 62xxx)
        message: message, // Isi pesan
        countryCode: "62", // Cadangan jika nomor tidak pakai kode negara
      },
      {
        headers: {
          Authorization: token, // Kunci akses
        },
      }
    );

    console.log(`Log Fonnte ke ${phone}:`, response.data);

    // Fonnte mengembalikan { status: true, ... } jika request diterima
    if (response.data.status) {
      return true;
    } else {
      console.error("Gagal Kirim Fonnte:", response.data.reason);
      return false;
    }
  } catch (error) {
    console.error("Error Axios Fonnte:", error.message);
    return false;
  }
};

module.exports = { formatPhoneNumber, sendWhatsappOTP };

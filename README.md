# MHUTEMP Backend Server

This is the backend server of the **MHUTEMP** project, responsible for receiving environmental data from ESP32 devices and storing it in a MongoDB database.

<img width="800" height="450" alt="image" src="https://github.com/user-attachments/assets/bde99a36-5b87-49c7-bd4f-49b2e0dba4dd" />

<img width="800" height="450" alt="image" src="https://github.com/user-attachments/assets/34de55ee-ea57-4189-9f9b-9bddf562f29f" />

## 🚀 Features

- REST API endpoint to receive temperature and humidity data.
- MongoDB integration for persistent storage.
- Data timestamping and validation.
- WebSocket server for real-time frontend updates.

## 🔧 Technologies Used

- Node.js
- Express.js
- MongoDB
- WebSocket

## 🛠️ Installation

1. Clone this repository:

```sh
git clone https://github.com/storres20/bio-data-pro.git
```

2. Install dependencies:
```sh
pnpm install
```

3. Create a `.env` file with your MongoDB connection string:
MONGODB_URI=your-mongodb-connection-string

4. Start the server:
```sh
pnpm start
```

## 📚 Related Repositories

- [MHUTEMP Frontend Application (Next.js)](https://github.com/storres20/bio-data-nextjs-pro)

# ⬡ Antares — Mine Bot Manager v2.0

> Dashboard quản lý bot Minecraft cao cấp với hỗ trợ CLI.
> Tự động nhận diện proxy · Quản lý nhiều bot đồng thời · Web UI trực tiếp.

🌐 **Ngôn ngữ:** [English](README.md) | **Tiếng Việt**

---

## ✨ Tính năng

| Hạng mục | Mô tả |
|---|---|
| 🤖 **Quản lý nhiều bot** | Chạy hàng chục bot cùng lúc với khởi động lệch giờ và giới hạn kết nối đồng thời |
| 🌐 **Tự động nhận diện Proxy** | HTTP / HTTPS / SOCKS4 / SOCKS5, tự nhận loại proxy, theo dõi tình trạng và bổ sung thông tin địa lý |
| 📊 **Web Dashboard trực tiếp** | Trạng thái, log, inventory, lệnh và chỉ số hệ thống theo thời gian thực |
| ⌨️ **Giao diện CLI** | Điều khiển đầy đủ bằng dòng lệnh song song với web UI |
| 🧭 **Auto Menu** | Tự động điều hướng menu server và xử lý GUI |
| 🚶 **Chế độ AFK** | AFK bằng nhảy hoặc đi bộ, kèm chống kẹt (anti-stuck) |
| 💎 **Theo dõi Shard** | Tự động đọc số lượng shard từ scoreboard và cửa sổ inventory |
| 📝 **Log riêng từng bot** | Mỗi bot có luồng log riêng biệt, không bị lẫn |
| 📱 **Thiết kế responsive** | UI Glassmorphism, ưu tiên mobile, nền gradient |

---

## 🚀 Bắt đầu nhanh

### Windows
```bat
setup.bat
run.bat
```

### Linux / macOS
```bash
chmod +x setup.sh run.sh
./setup.sh
./run.sh
```

### Cài đặt thủ công
```bash
npm install
node main.js
```

Sau khi chạy, mở **http://localhost:3000** trên trình duyệt để truy cập dashboard.

---

## ⚙️ Cấu hình

Chỉnh sửa file `config.json`:

```json
{
  "host": "server.com",
  "port": 25565,
  "version": "1.21.1",
  "ownerUsername": "YourName",
  "botPassword": "yourPassword",
  "bots": [
    {
      "id": "bot1",
      "host": "server.com",
      "port": 25565,
      "version": "1.21.1",
      "username": "BotName1",
      "botPassword": "password1",
      "useProxy": false
    }
  ],
  "proxies": [],
  "proxyAssignments": {}
}
```

| Field | Mô tả |
|---|---|
| `host` | IP server Minecraft mặc định |
| `port` | Cổng server mặc định (25565) |
| `version` | Phiên bản Minecraft |
| `ownerUsername` | Username của bạn dùng cho lệnh `/tpa` |
| `botPassword` | Mật khẩu dùng cho `/dk` và `/dn` (đăng ký/đăng nhập) |
| `bots[]` | Danh sách cấu hình các bot |
| `proxies[]` | Danh sách proxy (quản lý qua UI hoặc CLI) |
| `settings.webPort` | Cổng web dashboard (mặc định `3000`) |

### Định dạng Proxy

```
http://user:pass@host:port
socks5://user:pass@host:port
host:port:user:pass          (tự nhận diện)
host:port                    (không cần auth)
```

---

## ⌨️ Lệnh CLI

| Lệnh | Mô tả |
|---|---|
| `help` | Hiển thị danh sách lệnh |
| `list` | Liệt kê tất cả bot |
| `start <id>` | Khởi động một bot |
| `stop <id>` | Dừng một bot |
| `cmd <id> <command>` | Gửi lệnh tới bot |
| `proxy list` | Liệt kê proxy |
| `proxy add <string>` | Thêm proxy |
| `sys` | Xem chỉ số hệ thống |
| `exit` | Tắt chương trình |

---

## 📋 Yêu cầu

- **Node.js** >= 18
- **npm** >= 9

---

## 🗂️ Cấu trúc Project

```
antares/
├── main.js                  # Entry point
├── config.json              # Cấu hình bot & server
├── package.json             # Dependencies
├── setup.sh / setup.bat     # Script cài đặt
├── run.sh / run.bat         # Script khởi chạy
└── src/
    ├── core/                # Engine lõi
    │   ├── BotSession.js    # Vòng đời & event của bot
    │   ├── ProxyManager.js  # Quản lý & nhận diện proxy
    │   ├── CommandRegistry.js
    │   ├── WindowRouter.js  # Xử lý GUI Minecraft
    │   ├── PacketMonitor.js # Theo dõi tốc độ packet
    │   ├── constants.js     # Các hằng số thời gian & config
    │   └── utils.js         # Hàm tiện ích
    ├── services/
    │   └── BotManager.js    # Điều phối bot
    └── web/
        ├── WebDashboard.js  # Server Express + Socket.io
        └── public/          # Tài nguyên frontend
```

---

## ☁️ Deploy lên Render (Auto Deploy)

Bạn có thể deploy Antares lên [Render](https://render.com) để chạy 24/7 trên cloud, với auto-deploy mỗi khi push code lên GitHub.

### 1. Chuẩn bị repo

Đảm bảo repo có các file sau ở thư mục gốc:

- `package.json` với script `start` chạy `node main.js`
- (Khuyến nghị) file `render.yaml` để Render tự nhận cấu hình

Thêm vào `package.json`:

```json
{
  "scripts": {
    "start": "node main.js"
  },
  "engines": {
    "node": ">=18"
  }
}
```

### 2. Tạo file `render.yaml` (Infrastructure as Code)

Tạo file này ở thư mục gốc repo để Render tự động đọc cấu hình mỗi lần deploy:

```yaml
services:
  - type: web
    name: antares-bot-manager
    runtime: node
    plan: free          # đổi thành starter/standard nếu cần uptime ổn định hơn
    branch: main
    buildCommand: npm install
    startCommand: node main.js
    autoDeploy: true     # tự động deploy mỗi khi push lên branch trên
    envVars:
      - key: NODE_VERSION
        value: 18
      - key: PORT
        value: 3000
```

### 3. Tạo Web Service trên Render

1. Đăng nhập [dashboard.render.com](https://dashboard.render.com)
2. **New** → **Blueprint** (nếu dùng `render.yaml`) hoặc **New** → **Web Service** (cấu hình thủ công)
3. Kết nối tài khoản GitHub/GitLab và chọn repo Antares
4. Nếu tạo thủ công, điền:
   - **Build Command:** `npm install`
   - **Start Command:** `node main.js`
   - **Branch:** `main`
5. Bật **Auto-Deploy** ở phần Settings (mặc định đã bật khi tạo từ repo Git)
6. Nhấn **Create Web Service**

### 4. Cấu hình Environment Variables

Trong tab **Environment** của service, thêm các biến tương ứng với `config.json` của bạn (nếu bạn refactor để đọc từ `process.env`), ví dụ:

| Key | Value |
|---|---|
| `HOST` | `server.com` |
| `PORT` | `25565` |
| `WEB_PORT` | `3000` |
| `OWNER_USERNAME` | `YourName` |

> 💡 Render cấp một cổng động qua biến `PORT` — đảm bảo `WebDashboard.js` lắng nghe `process.env.PORT` để dashboard hoạt động đúng trên Render.

### 5. Auto Deploy hoạt động như thế nào

Khi `autoDeploy: true` (hoặc bật trong Settings):

- Mỗi lần bạn `git push` lên branch đã chọn (ví dụ `main`), Render sẽ tự động:
  1. Pull code mới nhất
  2. Chạy lại `buildCommand`
  3. Restart service với `startCommand`
- Bạn có thể theo dõi tiến trình deploy trực tiếp trong tab **Events** / **Logs** trên dashboard Render

### 6. Truy cập Dashboard sau khi deploy

Sau khi deploy thành công, Render sẽ cấp một URL dạng:

```
https://antares-bot-manager.onrender.com
```

Mở URL này để truy cập Web Dashboard thay cho `localhost:3000`.

> ⚠️ **Lưu ý:** Gói **Free** trên Render sẽ tự "ngủ" (spin down) sau một thời gian không có traffic, khiến các bot bị mất kết nối. Nếu cần bot online liên tục 24/7, nên dùng gói **Starter** trở lên hoặc kết hợp dịch vụ ping giữ instance thức.

---

## 📄 License

MIT
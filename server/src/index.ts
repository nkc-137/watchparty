import { createApp } from "./app";
import { parseAllowedOrigins } from "./limits";

const PORT = Number(process.env.PORT || 4000);
const JOIN_SECRET = process.env.JOIN_SECRET || "";
const ALLOWED_ORIGINS = parseAllowedOrigins(process.env.ALLOWED_ORIGINS);
const MAX_ROOM_SIZE = Number(process.env.MAX_ROOM_SIZE || 20);

const app = createApp({
  joinSecret: JOIN_SECRET,
  allowedOrigins: ALLOWED_ORIGINS,
  maxRoomSize: MAX_ROOM_SIZE,
});

app.listen(PORT).then(() => {
  console.log(`watchparty sync server listening on :${PORT}`);
  if (!JOIN_SECRET) console.log("WARNING: JOIN_SECRET not set — no join gate");
  if (ALLOWED_ORIGINS === "*") {
    console.log("WARNING: ALLOWED_ORIGINS=* — any website may open a socket");
  }
  console.log(`room cap: ${MAX_ROOM_SIZE} members`);
});

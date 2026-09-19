import { createApp } from "./app";

const PORT = Number(process.env.PORT || 4000);
const JOIN_SECRET = process.env.JOIN_SECRET || "";

const app = createApp({ joinSecret: JOIN_SECRET });

app.listen(PORT).then(() => {
  console.log(`watchparty sync server listening on :${PORT}`);
  if (!JOIN_SECRET) console.log("WARNING: JOIN_SECRET not set — no join gate");
});

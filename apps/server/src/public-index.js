import { createPublicApp } from "./public-app.js";
const { app, close } = createPublicApp();
const server = app.listen(Number(process.env.PORT || 3000), () => console.log("Dealify public app listening"));
for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, () => {
  server.close(async () => { await close(); process.exit(0); });
  const deadline = setTimeout(() => { server.closeAllConnections(); }, 20000);
  deadline.unref();
});

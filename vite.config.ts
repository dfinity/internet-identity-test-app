import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { nodePolyfills } from "vite-plugin-node-polyfills";

/** Origin of the locally running replica's HTTP gateway. */
const getReplicaHost = (): string => {
  try {
    const stdout = execSync("icp network status --json");
    const status = JSON.parse(stdout.toString());
    const port = new URL(status.gateway_url).port;
    return `http://127.0.0.1:${port}`;
  } catch (e) {
    throw Error(`Could not get replica port, is the replica running? ${e}`);
  }
};

const readCanisterId = ({ canisterName }: { canisterName: string }): string => {
  const command = `icp canister status ${canisterName} --id-only`;
  try {
    const stdout = execSync(command);
    return stdout.toString().trim();
  } catch (e) {
    throw Error(
      `Could not get canister ID for '${canisterName}' with command '${command}', was the canister deployed? ${e}`,
    );
  }
};

const rewriteRoute = (pathAndParams: string): string => {
  let queryParamsString = `?`;

  const [path, params] = pathAndParams.split("?");

  if (params) {
    queryParamsString += `${params}&`;
  }

  queryParamsString += `canisterId=${readCanisterId({
    canisterName: "test_app",
  })}`;

  return path + queryParamsString;
};

export default defineConfig(({ command, mode }) => ({
  root: "./src",
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    rollupOptions: {
      // Two entries: the homepage and the ICRC-167 redirect callback page.
      input: {
        index: fileURLToPath(new URL("./src/index.html", import.meta.url)),
        callback: fileURLToPath(
          new URL("./src/callback.html", import.meta.url),
        ),
      },
      output: {
        entryFileNames: `[name].js`,
        chunkFileNames: `[name].js`,
        assetFileNames: `[name].[ext]`,
      },
    },
  },
  optimizeDeps: {
    esbuildOptions: {
      define: {
        global: "globalThis",
      },
    },
  },
  plugins: [nodePolyfills({ include: ["buffer"] })],
  server:
    command !== "serve"
      ? undefined
      : {
          port: 8081,
          // Set up a proxy that redirects API calls and /index.html to the
          // replica; the rest we serve from here.
          proxy: {
            "/api": getReplicaHost(),
            "/.well-known/ii-alternative-origins": {
              target: getReplicaHost(),
              rewrite: rewriteRoute,
            },
            "/.well-known/evil-alternative-origins": {
              target: getReplicaHost(),
              rewrite: rewriteRoute,
            },
          },
        },
}));

import { readServerId } from "../server-id.ts";
import { identify, json, type RequestContext, type Route } from "./http.ts";
import { toGuid } from "./request.ts";

// Clients pick their API dialect from the version, and Thalia speaks 10.10.
const productName = "Jellyfin Server";
const version = "10.10.7";
const serverName = "Thalia";

async function publicInfo(context: RequestContext) {
  const { secure } = await identify(context);
  const { url } = context;
  return {
    port: Number(url.port) || (secure ? 443 : 80),
    info: {
      LocalAddress: `${secure ? "https" : "http"}://${url.host}`,
      ServerName: serverName,
      Version: version,
      ProductName: productName,
      OperatingSystem: "",
      Id: toGuid(await readServerId(context.db)),
      StartupWizardCompleted: true,
    },
  };
}

/** Server identity for the connect screen, and the fuller version for signed-in clients. */
export const systemRoutes: Route[] = [
  {
    method: "GET",
    path: "/System/Info/Public",
    anonymous: true,
    handle: async (context) => json((await publicInfo(context)).info),
  },
  {
    method: "GET",
    path: "/System/Info",
    handle: async (context) => {
      const { port, info } = await publicInfo(context);
      return json({
        ...info,
        HasPendingRestart: false,
        IsShuttingDown: false,
        SupportsLibraryMonitor: true,
        WebSocketPortNumber: port,
        CompletedInstallations: [],
        CanSelfRestart: false,
        CanLaunchWebBrowser: false,
        CastReceiverApplications: [],
        HasUpdateAvailable: false,
      });
    },
  },
];

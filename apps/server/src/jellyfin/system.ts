import { readServerId } from "../server-id.ts";
import { identify, json, type RequestContext, type Route } from "./http.ts";
import { defaultValue, openapi, specificationSource } from "./openapi.ts";
import { toGuid } from "./request.ts";

const productName = "Jellyfin Server";
const version = specificationSource.version;
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
  ...(["GET", "POST"] as const).map(
    (method): Route => ({
      method,
      path: "/System/Ping",
      anonymous: true,
      handle: () => json("Jellyfin Server"),
    }),
  ),
  {
    method: "GET",
    path: "/GetUtcTime",
    anonymous: true,
    handle: () =>
      json({
        RequestReceptionTime: new Date().toISOString(),
        ResponseTransmissionTime: new Date().toISOString(),
      }),
  },
  {
    method: "GET",
    path: "/System/Configuration",
    handle: () =>
      json({
        ...(defaultValue(
          openapi.components.schemas.ServerConfiguration ?? {},
        ) as object),
        IsStartupWizardCompleted: true,
        QuickConnectAvailable: true,
        PreferredMetadataLanguage: "en",
        MetadataCountryCode: "US",
        EnableFolderView: true,
        MinResumePct: 5,
        MaxResumePct: 90,
        MinResumeDurationSeconds: 300,
      }),
  },
  {
    method: "GET",
    path: "/System/Configuration/{key}",
    handle: () => json({}),
  },
  {
    method: "GET",
    path: "/System/Endpoint",
    handle: async (context) => {
      const { address } = await identify(context);
      const local = ["127.0.0.1", "::1"].includes(address);
      return json({ IsLocal: local, IsInNetwork: local });
    },
  },
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

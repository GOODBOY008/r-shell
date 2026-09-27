import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Globe, Plus, X } from "lucide-react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { cn } from "@/lib/utils";
import {
  startSocksProxy,
  stopSocksProxy,
  useSocksProxies,
} from "@/lib/socks-proxy-store";

interface PortForwardingPanelProps {
  connectionId: string | null;
  /** tab.id → display name: every proxy's connection_id is a tab id. */
  connectionNames: Record<string, string>;
}

export function PortForwardingPanel({ connectionId, connectionNames }: PortForwardingPanelProps) {
  const { t } = useTranslation();
  const proxies = useSocksProxies();
  const [bindAddress, setBindAddress] = useState("127.0.0.1");
  const [bindPort, setBindPort] = useState("1080");
  const [loading, setLoading] = useState(false);

  const port = parseInt(bindPort, 10);
  const portValid = !isNaN(port) && port >= 1 && port <= 65535;
  const duplicate =
    connectionId != null &&
    portValid &&
    proxies.some((p) => p.connection_id === connectionId && p.bind_port === port);

  const handleStart = async () => {
    if (!connectionId) {
      toast.error(t("portForwarding.noConnection"));
      return;
    }
    if (!portValid) {
      toast.error(t("portForwarding.invalidPort"));
      return;
    }
    if (duplicate) {
      toast.error(t("portForwarding.alreadyRunning"));
      return;
    }
    setLoading(true);
    try {
      const res = await startSocksProxy(connectionId, bindAddress, port);
      if (res.ok) {
        toast.success(
          t("portForwarding.started", {
            address: bindAddress,
            port: res.actualPort ?? port,
          }),
        );
      } else {
        toast.error(t("portForwarding.startFailed"), { description: res.error });
      }
    } finally {
      setLoading(false);
    }
  };

  const handleStop = async (proxyId: string) => {
    const res = await stopSocksProxy(proxyId);
    if (res.ok) {
      toast.success(t("portForwarding.stopped"));
    } else {
      toast.error(t("portForwarding.stopFailed"), { description: res.error });
    }
  };

  return (
    <div className="h-full flex flex-col">
      <div className="flex-1 overflow-auto p-2 space-y-2">
        {proxies.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center pt-4">
            {t("portForwarding.noProxies")}
          </p>
        ) : (
          proxies.map((p) => {
            const isActiveConnection = p.connection_id === connectionId;
            const label = connectionNames[p.connection_id] ?? p.connection_id;
            return (
              <div
                key={p.proxy_id}
                className={cn(
                  "flex items-center justify-between rounded border p-2 text-sm",
                  isActiveConnection && "border-primary/50 bg-primary/5",
                )}
              >
                <div className="flex items-center gap-2 min-w-0">
                  <Globe className="h-3 w-3 shrink-0 text-green-500" aria-hidden />
                  <div className="flex flex-col min-w-0">
                    <span className="truncate font-mono">
                      {p.bind_address}:{p.bind_port}
                    </span>
                    <span className="truncate text-xs text-muted-foreground" title={label}>
                      {label}
                    </span>
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 shrink-0"
                  aria-label={t("portForwarding.stop")}
                  onClick={() => handleStop(p.proxy_id)}
                >
                  <X className="h-3 w-3" />
                </Button>
              </div>
            );
          })
        )}
      </div>

      <div className="border-t p-2 space-y-2">
        <p className="text-xs font-medium text-muted-foreground">{t("portForwarding.newProxy")}</p>
        <div className="flex items-center gap-1">
          <div className="flex-1">
            <Label className="sr-only" htmlFor="bind-address">{t("portForwarding.bindAddress")}</Label>
            <Input
              id="bind-address"
              placeholder="127.0.0.1"
              className="h-7 text-xs"
              value={bindAddress}
              onChange={(e) => setBindAddress(e.target.value)}
            />
          </div>
          <span className="text-muted-foreground">:</span>
          <div className="w-20">
            <Label className="sr-only" htmlFor="bind-port">{t("portForwarding.bindPort")}</Label>
            <Input
              id="bind-port"
              placeholder="1080"
              inputMode="numeric"
              className="h-7 text-xs"
              value={bindPort}
              onChange={(e) => setBindPort(e.target.value)}
            />
          </div>
          <Button
            size="sm"
            className="h-7 px-2"
            onClick={handleStart}
            disabled={loading || !connectionId}
            title={!connectionId ? t("portForwarding.noConnection") : undefined}
          >
            <Plus className="h-3 w-3 mr-1" />
            {t("portForwarding.start")}
          </Button>
        </div>
      </div>
    </div>
  );
}

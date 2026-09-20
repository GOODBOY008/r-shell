import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import { Plus, X, Circle, CircleDot } from "lucide-react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";

export const SOCKS_PROXY_STATE_KEY = "r-shell-socks-proxy-state";

interface SocksProxyInfo {
  proxy_id: string;
  connection_id: string;
  bind_address: string;
  bind_port: number;
  active: boolean;
}

/** Persist current proxy list to localStorage so session restore can recreate them. */
export async function persistProxyState(): Promise<void> {
  try {
    const list = await invoke<SocksProxyInfo[]>("list_socks_proxies");
    localStorage.setItem(SOCKS_PROXY_STATE_KEY, JSON.stringify(list));
  } catch {
    // ignore
  }
}

interface PortForwardingPanelProps {
  connectionId: string | null;
}

export function PortForwardingPanel({ connectionId }: PortForwardingPanelProps) {
  const { t } = useTranslation();
  const [proxies, setProxies] = useState<SocksProxyInfo[]>([]);
  const [bindAddress, setBindAddress] = useState("127.0.0.1");
  const [bindPort, setBindPort] = useState("1080");
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const list = await invoke<SocksProxyInfo[]>("list_socks_proxies");
      setProxies(list);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 3000);
    return () => clearInterval(interval);
  }, [refresh]);

  const handleStart = async () => {
    if (!connectionId) {
      toast.error(t("portForwarding.noConnection"));
      return;
    }
    const proxyId = `socks-${connectionId}-${Date.now()}`;
    const port = parseInt(bindPort, 10);
    if (isNaN(port) || port < 1 || port > 65535) {
      toast.error(t("portForwarding.invalidPort"));
      return;
    }
    setLoading(true);
    try {
      const res = await invoke<{ success: boolean; actual_port?: number; error?: string }>("start_socks_proxy", {
        request: {
          proxy_id: proxyId,
          connection_id: connectionId,
          bind_address: bindAddress,
          bind_port: port,
        },
      });
      if (res.success) {
        toast.success(t("portForwarding.started", {
          address: bindAddress,
          port: res.actual_port ?? port,
        }));
        await persistProxyState();
        refresh();
      } else {
        toast.error(t("portForwarding.startFailed"), { description: res.error });
      }
    } catch (e: any) {
      toast.error(t("portForwarding.startFailed"), { description: String(e) });
    } finally {
      setLoading(false);
    }
  };

  const handleStop = async (proxyId: string) => {
    try {
      const res = await invoke<{ success: boolean; output?: string; error?: string }>("stop_socks_proxy", {
        proxyId,
      });
      if (res.success) {
        toast.success(res.output ?? t("portForwarding.stopped"));
        await persistProxyState();
        refresh();
      } else {
        toast.error(t("portForwarding.stopFailed"), { description: res.error });
      }
    } catch (e: any) {
      toast.error(t("portForwarding.stopFailed"), { description: String(e) });
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
          proxies.map((p) => (
            <div
              key={p.proxy_id}
              className="flex items-center justify-between rounded border p-2 text-sm"
            >
              <div className="flex items-center gap-2 min-w-0">
                {p.active ? (
                  <CircleDot className="h-3 w-3 shrink-0 text-green-500" />
                ) : (
                  <Circle className="h-3 w-3 shrink-0 text-muted-foreground" />
                )}
                <span className="truncate font-mono">
                  {p.bind_address}:{p.bind_port}
                </span>
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
          ))
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
          >
            <Plus className="h-3 w-3 mr-1" />
            {t("portForwarding.start")}
          </Button>
        </div>
      </div>
    </div>
  );
}

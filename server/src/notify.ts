import { request } from 'undici';
import type { Severity } from './alerts.js';

/**
 * Notification dispatch. Supports ntfy (default — free, no account), Pushover,
 * and a generic JSON webhook. Channel + credentials come from env.
 */

export type NotifyChannel = 'ntfy' | 'pushover' | 'webhook' | 'none';

export interface NotifyConfig {
  channel: NotifyChannel;
  minSeverity: Severity;        // 'warning' = warning+critical; 'critical' = critical only
  notifyResolved: boolean;      // also send when an alert clears
  ntfyServer: string;
  ntfyTopic: string;
  pushoverToken: string;
  pushoverUser: string;
  webhookUrl: string;
}

export function loadNotifyConfig(): NotifyConfig {
  const sev = (process.env.NOTIFY_MIN_SEVERITY ?? 'warning').toLowerCase();
  return {
    channel: (process.env.NOTIFY_CHANNEL ?? 'none').toLowerCase() as NotifyChannel,
    minSeverity: sev === 'critical' ? 'critical' : 'warning',
    notifyResolved: process.env.NOTIFY_RESOLVED !== '0',
    ntfyServer: process.env.NOTIFY_NTFY_SERVER ?? 'https://ntfy.sh',
    ntfyTopic: process.env.NOTIFY_NTFY_TOPIC ?? '',
    pushoverToken: process.env.NOTIFY_PUSHOVER_TOKEN ?? '',
    pushoverUser: process.env.NOTIFY_PUSHOVER_USER ?? '',
    webhookUrl: process.env.NOTIFY_WEBHOOK_URL ?? '',
  };
}

export interface NotifyMessage {
  title: string;
  body: string;
  severity: Severity | 'resolved';
}

/** True if the channel is configured well enough to actually send. */
export function isConfigured(cfg: NotifyConfig): boolean {
  switch (cfg.channel) {
    case 'ntfy':
      return !!cfg.ntfyTopic;
    case 'pushover':
      return !!cfg.pushoverToken && !!cfg.pushoverUser;
    case 'webhook':
      return !!cfg.webhookUrl;
    default:
      return false;
  }
}

const NTFY_PRIORITY: Record<NotifyMessage['severity'], string> = {
  critical: '5',
  warning: '4',
  info: '3',
  resolved: '2',
};
const NTFY_TAGS: Record<NotifyMessage['severity'], string> = {
  critical: 'rotating_light',
  warning: 'warning',
  info: 'information_source',
  resolved: 'white_check_mark',
};
const PUSHOVER_PRIORITY: Record<NotifyMessage['severity'], number> = {
  critical: 1,
  warning: 0,
  info: -1,
  resolved: -1,
};

export async function sendNotification(cfg: NotifyConfig, msg: NotifyMessage): Promise<void> {
  if (cfg.channel === 'none') return;

  if (cfg.channel === 'ntfy') {
    if (!cfg.ntfyTopic) throw new Error('ntfy topic not set');
    const url = `${cfg.ntfyServer.replace(/\/$/, '')}/${cfg.ntfyTopic}`;
    const res = await request(url, {
      method: 'POST',
      headers: {
        Title: msg.title,
        Priority: NTFY_PRIORITY[msg.severity],
        Tags: NTFY_TAGS[msg.severity],
      },
      body: msg.body,
    });
    if (res.statusCode >= 300) {
      throw new Error(`ntfy returned HTTP ${res.statusCode}`);
    }
    return;
  }

  if (cfg.channel === 'pushover') {
    if (!cfg.pushoverToken || !cfg.pushoverUser) throw new Error('Pushover token/user not set');
    const form = new URLSearchParams({
      token: cfg.pushoverToken,
      user: cfg.pushoverUser,
      title: msg.title,
      message: msg.body,
      priority: String(PUSHOVER_PRIORITY[msg.severity]),
    });
    const res = await request('https://api.pushover.net/1/messages.json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    if (res.statusCode >= 300) {
      throw new Error(`Pushover returned HTTP ${res.statusCode}`);
    }
    return;
  }

  if (cfg.channel === 'webhook') {
    if (!cfg.webhookUrl) throw new Error('Webhook URL not set');
    const res = await request(cfg.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: msg.title, body: msg.body, severity: msg.severity, ts: Date.now() }),
    });
    if (res.statusCode >= 300) {
      throw new Error(`Webhook returned HTTP ${res.statusCode}`);
    }
    return;
  }
}

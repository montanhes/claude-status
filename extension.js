import St from 'gi://St';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup?version=3.0';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension, gettext as _, pgettext} from 'resource:///org/gnome/shell/extensions/extension.js';

const REFRESH_SECONDS = 300;
const TICK_SECONDS = 1;
const BAR_WIDTH = 220;
const SUBPROCESS_TIMEOUT_SECONDS = 25;
const RETRY_BASE_SECONDS = 15;
const RETRY_MAX_SECONDS = 120;
const MAX_RETRIES = 5;

const STATUS_URL = 'https://status.claude.com/api/v2/status.json';
const STATUS_PAGE_URL = 'https://status.claude.com';

// Explicit lookup path for the `claude` binary. The extension used to run the
// command through `bash -lc`, which sourced ~/.profile and friends inside the
// gnome-shell process every refresh and resolved `claude` from whatever PATH
// those files happened to build. Both are avoided by spawning directly with a
// fixed PATH.
const CLAUDE_PATH_DIRS = [
    `${GLib.get_home_dir()}/.local/bin`,
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/snap/bin',
];

// Resolved against CLAUDE_PATH_DIRS rather than GLib.find_program_in_path(),
// which would search gnome-shell's own PATH instead of the one handed to the
// subprocess.
function findClaudeBinary() {
    for (const dir of CLAUDE_PATH_DIRS) {
        const candidate = `${dir}/claude`;
        if (GLib.file_test(candidate, GLib.FileTest.IS_EXECUTABLE))
            return candidate;
    }
    return null;
}

const STATUS_COLORS = {
    none: '#2ecc71',
    minor: '#f1c40f',
    major: '#e67e22',
    critical: '#e74c3c',
};

function statusIndicatorLabel(indicator) {
    const labels = {
        none: _('All Systems Operational'),
        minor: _('Minor Service Disruption'),
        major: _('Major Service Disruption'),
        critical: _('Critical Service Disruption'),
    };
    return labels[indicator] ?? null;
}

const MONTHS = {
    jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
    jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

function colorForPercent(pct) {
    if (pct >= 80)
        return '#e74c3c';
    if (pct >= 50)
        return '#f1c40f';
    return '#2ecc71';
}

function parseResetDate(text, now) {
    // ex: "Jul 23, 7:40pm" ou "Jul 25, 12am"
    const m = text.match(/([A-Za-z]{3})\s+(\d{1,2}),?\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i);
    if (!m)
        return null;

    const month = MONTHS[m[1].toLowerCase().slice(0, 3)];
    if (month === undefined)
        return null;

    const day = parseInt(m[2], 10);
    let hour = parseInt(m[3], 10);
    const minute = m[4] ? parseInt(m[4], 10) : 0;
    const ampm = m[5].toLowerCase();

    if (ampm === 'pm' && hour !== 12)
        hour += 12;
    if (ampm === 'am' && hour === 12)
        hour = 0;

    const date = new Date(now.getFullYear(), month, day, hour, minute, 0);
    if (date < now)
        date.setFullYear(date.getFullYear() + 1);

    return date;
}

function formatCountdown(resetDate, now) {
    if (!resetDate)
        return '--';
    let diff = resetDate.getTime() - now.getTime();
    if (diff < 0)
        diff = 0;

    const days = Math.floor(diff / 86400000);
    const hours = Math.floor((diff % 86400000) / 3600000);
    const minutes = Math.floor((diff % 3600000) / 60000);

    if (days > 0)
        return `${days}d ${hours}h`;
    if (hours > 0)
        return `${hours}h ${minutes}m`;
    return `${minutes}m`;
}

function panelLabel(sessionText, weekText) {
    const sessionAbbr = pgettext('short abbreviation for "session" shown in the top bar', 'S');
    const weekAbbr = pgettext('short abbreviation for "week" shown in the top bar', 'W');
    return `${sessionAbbr} ${sessionText} | ${weekAbbr} ${weekText}`;
}

function parseUsage(output) {
    const sessionMatch = output.match(/Current session:\s*(\d+)%\s*used\s*·\s*resets\s*([^\n]+)/i);
    const weekMatch = output.match(/Current week[^:]*:\s*(\d+)%\s*used\s*·\s*resets\s*([^\n]+)/i);

    if (!sessionMatch || !weekMatch)
        return null;

    return {
        session: {pct: parseInt(sessionMatch[1], 10), resetText: sessionMatch[2].trim()},
        week: {pct: parseInt(weekMatch[1], 10), resetText: weekMatch[2].trim()},
    };
}

const UsageCard = GObject.registerClass(
class UsageCard extends St.BoxLayout {
    _init(title) {
        super._init({vertical: true, style_class: 'claude-card', x_expand: true});

        this.add_child(new St.Label({text: title, style_class: 'claude-card-title'}));

        this._pctLabel = new St.Label({text: '--%', style_class: 'claude-card-pct'});
        this.add_child(this._pctLabel);

        this._barBg = new St.Widget({style_class: 'claude-bar-bg', width: BAR_WIDTH, height: 10});
        this._barFill = new St.Widget({style_class: 'claude-bar-fill', height: 10});
        this._barBg.add_child(this._barFill);
        this.add_child(this._barBg);

        this._resetLabel = new St.Label({text: '', style_class: 'claude-card-reset'});
        this.add_child(this._resetLabel);

        this._countdownLabel = new St.Label({text: '', style_class: 'claude-card-countdown'});
        this.add_child(this._countdownLabel);
    }

    setData(pct, resetText) {
        this._pctLabel.set_text(`${pct}%`);
        this._pctLabel.set_style(`color: ${colorForPercent(pct)};`);

        const width = Math.round((BAR_WIDTH * Math.min(pct, 100)) / 100);
        this._barFill.set_width(width);
        this._barFill.set_style(`background-color: ${colorForPercent(pct)};`);

        // TRANSLATORS: %s is a date/time string, e.g. "Jul 23, 7:40pm"
        this._resetLabel.set_text(_('Resets at · %s').replace('%s', resetText));
    }

    setCountdown(text) {
        this._countdownLabel.set_text(text);
    }
});

const ClaudeIndicator = GObject.registerClass(
class ClaudeIndicator extends PanelMenu.Button {
    _init(extension) {
        super._init(0.0, _('Claude Status'));

        this._extension = extension;
        this._lastUpdate = null;
        this._data = null;
        this._refreshing = false;
        this._retryCount = 0;
        this._retryTimer = null;
        this._watchdogId = null;
        this._cancellable = null;
        this._destroyed = false;
        this._statusRefreshing = false;
        this._httpSession = new Soup.Session({timeout: 10});

        const box = new St.BoxLayout({style_class: 'claude-panel-box'});

        this._icon = new St.Icon({
            gicon: Gio.icon_new_for_string(
                `${extension.path}/icons/claude-ai-symbol.svg`),
            style_class: 'system-status-icon',
        });
        box.add_child(this._icon);

        this._label = new St.Label({
            text: panelLabel('--%', '--%'),
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'claude-panel-label',
        });
        box.add_child(this._label);

        this.add_child(box);

        this._buildMenu();
        this._refresh();
        this._refreshStatus();

        this._refreshTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, REFRESH_SECONDS, () => {
            this._refresh();
            this._refreshStatus();
            return GLib.SOURCE_CONTINUE;
        });

        this._tickTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, TICK_SECONDS, () => {
            this._tick();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _buildMenu() {
        const headerItem = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        const headerBox = new St.BoxLayout({style_class: 'claude-header', x_expand: true});

        headerBox.add_child(new St.Label({
            text: 'Claude Code',
            style_class: 'claude-header-title',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        }));

        this._updatedLabel = new St.Label({
            text: '',
            style_class: 'claude-header-updated',
            y_align: Clutter.ActorAlign.CENTER,
        });
        headerBox.add_child(this._updatedLabel);

        const refreshBtn = new St.Button({
            style_class: 'claude-refresh-btn',
            child: new St.Icon({icon_name: 'view-refresh-symbolic', icon_size: 14}),
        });
        refreshBtn.connect('clicked', () => this._refresh());
        headerBox.add_child(refreshBtn);

        headerItem.add_child(headerBox);
        this.menu.addMenuItem(headerItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const cardsItem = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        const cardsBox = new St.BoxLayout({style_class: 'claude-cards-box', x_expand: true});

        this._sessionCard = new UsageCard(_('SESSION (5h)'));
        this._weekCard = new UsageCard(_('WEEK'));
        cardsBox.add_child(this._sessionCard);
        cardsBox.add_child(this._weekCard);

        cardsItem.add_child(cardsBox);
        this.menu.addMenuItem(cardsItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._statusItem = new PopupMenu.PopupBaseMenuItem();
        const statusBox = new St.BoxLayout({style_class: 'claude-status-box', x_expand: true});

        this._statusDot = new St.Widget({style_class: 'claude-status-dot'});
        statusBox.add_child(this._statusDot);

        this._statusLabel = new St.Label({
            text: _('Checking status…'),
            style_class: 'claude-status-label',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        statusBox.add_child(this._statusLabel);

        this._statusItem.add_child(statusBox);
        this._statusItem.connect('activate', () => {
            Gio.AppInfo.launch_default_for_uri(STATUS_PAGE_URL, null);
        });
        this.menu.addMenuItem(this._statusItem);

        this._menuOpenStateId = this.menu.connect('open-state-changed', (menu, open) => {
            if (open)
                this._tick();
        });
    }

    _tick() {
        if (!this._lastUpdate)
            return;

        const now = new Date();

        if (this._data) {
            const sessionReset = parseResetDate(this._data.session.resetText, this._lastUpdate);
            const weekReset = parseResetDate(this._data.week.resetText, this._lastUpdate);
            this._sessionCard.setCountdown(formatCountdown(sessionReset, now));
            this._weekCard.setCountdown(formatCountdown(weekReset, now));
        }

        if (this.menu.isOpen) {
            const secs = Math.max(0, Math.round((now - this._lastUpdate) / 1000));
            // TRANSLATORS: %d is the number of seconds since the last refresh
            this._updatedLabel.set_text(_('updated %ds ago').replace('%d', secs));
        }
    }

    _refresh() {
        if (this._refreshing)
            return;
        this._refreshing = true;

        if (this._retryTimer) {
            GLib.source_remove(this._retryTimer);
            this._retryTimer = null;
        }

        let proc;
        this._cancellable = new Gio.Cancellable();
        try {
            const path = CLAUDE_PATH_DIRS.join(':');
            const launcher = new Gio.SubprocessLauncher({
                flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
            });
            launcher.setenv('PATH', path, true);
            launcher.set_cwd(GLib.get_home_dir());

            const claudeBin = findClaudeBinary();
            if (!claudeBin)
                throw new Error(`claude binary not found in ${path}`);

            proc = launcher.spawnv([claudeBin, '-p', '/usage']);
        } catch (e) {
            logError(e, 'claude-status: falha ao iniciar subprocess');
            this._refreshing = false;
            this._cancellable = null;
            this._scheduleRetry();
            return;
        }

        let watchdogFired = false;
        if (this._watchdogId) {
            GLib.source_remove(this._watchdogId);
            this._watchdogId = null;
        }
        this._watchdogId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT, SUBPROCESS_TIMEOUT_SECONDS, () => {
                watchdogFired = true;
                this._watchdogId = null;
                logError(new Error(`claude-status: comando excedeu ${SUBPROCESS_TIMEOUT_SECONDS}s, cancelando`));
                this._cancellable?.cancel();
                return GLib.SOURCE_REMOVE;
            });

        proc.communicate_utf8_async(null, this._cancellable, (source, res) => {
            if (this._watchdogId && !watchdogFired) {
                GLib.source_remove(this._watchdogId);
                this._watchdogId = null;
            }
            this._refreshing = false;
            this._cancellable = null;
            if (this._destroyed)
                return;
            try {
                const [, stdout, stderr] = source.communicate_utf8_finish(res);
                const exitStatus = source.get_exit_status();

                if (exitStatus !== 0) {
                    logError(new Error(
                        `claude-status: comando saiu com codigo ${exitStatus}. stderr: ${(stderr ?? '').trim()}`));
                    this._scheduleRetry();
                    return;
                }

                const parsed = parseUsage(stdout ?? '');
                if (!parsed) {
                    logError(new Error(`claude-status: saida inesperada: ${stdout}`));
                    this._scheduleRetry();
                    return;
                }

                this._retryCount = 0;
                this._data = parsed;
                this._lastUpdate = new Date();

                this._label.set_text(panelLabel(`${parsed.session.pct}%`, `${parsed.week.pct}%`));
                this._sessionCard.setData(parsed.session.pct, parsed.session.resetText);
                this._weekCard.setData(parsed.week.pct, parsed.week.resetText);
                this._tick();
            } catch (e) {
                logError(e, 'claude-status: falha ao ler saida do comando');
                this._scheduleRetry();
            }
        });
    }

    _scheduleRetry() {
        if (this._retryCount >= MAX_RETRIES)
            return;

        this._retryCount += 1;
        const delay = Math.min(RETRY_BASE_SECONDS * this._retryCount, RETRY_MAX_SECONDS);

        if (this._retryTimer) {
            GLib.source_remove(this._retryTimer);
            this._retryTimer = null;
        }
        this._retryTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, delay, () => {
            this._retryTimer = null;
            this._refresh();
            return GLib.SOURCE_REMOVE;
        });
    }

    async _refreshStatus() {
        if (this._statusRefreshing)
            return;
        this._statusRefreshing = true;

        try {
            const message = Soup.Message.new('GET', STATUS_URL);
            const bytes = await this._httpSession.send_and_read_async(
                message, GLib.PRIORITY_DEFAULT, null);

            if (message.get_status() !== Soup.Status.OK)
                throw new Error(`HTTP ${message.get_status()}`);

            const text = new TextDecoder('utf-8').decode(bytes.get_data());
            const json = JSON.parse(text);
            const indicator = json.status?.indicator ?? 'none';
            const description = statusIndicatorLabel(indicator) ?? json.status?.description ?? _('Unknown');
            const color = STATUS_COLORS[indicator] ?? STATUS_COLORS.none;

            if (this._destroyed)
                return;
            this._statusDot.set_style(`background-color: ${color};`);
            this._statusLabel.set_text(description);
        } catch (e) {
            if (!this._destroyed) {
                logError(e, 'claude-status: falha ao consultar status.claude.com');
                this._statusDot.set_style(`background-color: ${STATUS_COLORS.none};`);
                this._statusLabel.set_text(_('Status unavailable'));
            }
        } finally {
            this._statusRefreshing = false;
        }
    }

    destroy() {
        this._destroyed = true;

        if (this._refreshTimer) {
            GLib.source_remove(this._refreshTimer);
            this._refreshTimer = null;
        }
        if (this._tickTimer) {
            GLib.source_remove(this._tickTimer);
            this._tickTimer = null;
        }
        if (this._retryTimer) {
            GLib.source_remove(this._retryTimer);
            this._retryTimer = null;
        }
        if (this._watchdogId) {
            GLib.source_remove(this._watchdogId);
            this._watchdogId = null;
        }
        if (this._menuOpenStateId) {
            this.menu.disconnect(this._menuOpenStateId);
            this._menuOpenStateId = null;
        }

        this._cancellable?.cancel();
        this._httpSession?.abort();

        super.destroy();
    }
});

export default class ClaudeStatusExtension extends Extension {
    enable() {
        this._indicator = new ClaudeIndicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}

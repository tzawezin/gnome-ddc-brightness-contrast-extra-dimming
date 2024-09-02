/* extension.js
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 2 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

/* exported init */

const GETTEXT_DOMAIN = 'my-indicator-extension';

const { GLib, GObject, St, Gio, Clutter } = imports.gi;
const Slider = imports.ui.slider;

const ExtensionUtils = imports.misc.extensionUtils;
const Main = imports.ui.main;
const PanelMenu = imports.ui.panelMenu;
const PopupMenu = imports.ui.popupMenu;
const _ = ExtensionUtils.gettext;
const ddcNrs = {
    brightness: "10",
    contrast: "12"
};
const ddcutil_path = "/usr/bin/ddcutil";

function changeSet(display, set, value) {
    GLib.spawn_command_line_async(`${ddcutil_path} setvcp ${ddcNrs[set]} ${value} --bus ${display.bus}`);
}

let displays = [];

async function getCmdOut(cmd) {
    return new Promise((resolve, reject) => {
        let process = Gio.Subprocess.new(cmd, Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
        process.communicate_utf8_async(null, null, (proc, res) => {
            try {
                let [, stdout, stderr] = process.communicate_utf8_finish(res);
                if (proc.get_successful()) {
                    resolve(stdout);
                } else {
                    if (stderr) {
                        reject(stderr);
                    } else if (stdout) {
                        resolve(stdout);
                    }
                }
            } catch (e) {
                reject(e);
            }
        });
    });
}

const Indicator = GObject.registerClass(
    class Indicator extends PanelMenu.Button {
        _init() {
            super._init(0.0, _('My Shiny Indicator'));
            this.add_child(new St.Icon({
                icon_name: 'face-smile-symbolic',
                style_class: 'system-status-icon',
            }));
            const getDisplays = async () => {
                let res;
                try {
                    res = await getCmdOut(['ddcutil', 'detect', '--brief']);
                } catch (e) {
                    logError(e, 'getCmdOutError');
                }
                if (!res) {
                    return;
                }
                const displayArray = res.split('\n\n').slice(0, -1);
                const l = displayArray.length;
                for (let i = 0; i < l; i++) {
                    const v = displayArray[i];
                    let display = {};
                    display['ddc'] = !v.includes('Invalid')
                    const arr = v.split('\n');
                    display['i'] = i;
                    const nameLine = arr.find(a => a.includes('Monitor'));
                    const busLine = arr.find(a => a.includes('I2C bus'));
                    display['name'] = nameLine.split(':')[2].trim() || "monitor " + (Number(display.i) + 1);
                    display['bus'] = busLine.split('/dev/i2c-')[1].trim();
                    display['sliderTimeouts'] = {};
                    await newDisplayObj(display);
                    newOverlaySlider(display);
                    displays.push(display);
                };
            }
            const newOverlaySlider = (display) => {
                let item = new PopupMenu.PopupBaseMenuItem({ activate: false });
                let slider = new Slider.Slider(0);
                let sliderT = new St.Label({ text: '0%' });
                const monitors = [...Main.layoutManager.monitors];
                let monitor = monitors[(display.i + 1) % monitors.length];
                display.overlay = new Clutter.Actor({
                    x: monitor.x,
                    y: monitor.y,
                    width: monitor.width,
                    height: monitor.height,
                    background_color: new Clutter.Color({
                        red: 0,
                        green: 0,
                        blue: 0,
                        alpha: 255
                    }),
                    opacity: 0
                });
                Main.uiGroup.add_actor(display.overlay);
                const sliderChange = () => {
                    const value = slider.value * 100;
                    sliderT.text = value.toFixed(0) + '%';
                    display.overlay.set_opacity(value * 2.3);
                };
                slider.connect('notify::value', sliderChange);
                item.add_child(slider);
                item.add_child(sliderT);
                this.menu.addMenuItem(item);
            }
            const newDisplayObj = async (display) => {
                const makeSlider = async (set) => {
                    let menuItem = new PopupMenu.PopupBaseMenuItem({ activate: false });
                    let oldValue = await getCmdOut(['ddcutil', 'getvcp', '--brief', ddcNrs[set], '--bus', display.bus]);
                    oldValue = Number(oldValue.split(' ')[3]);
                    let slider = new Slider.Slider((oldValue) / 100);
                    let sliderText = new St.Label({ text: oldValue + '%' });
                    let waiting = false;
                    const limit = async () => {
                        if (waiting) return;
                        waiting = true;
                        await new Promise(r => display.sliderTimeouts[set] = setTimeout(() => {
                            delete display.sliderTimeouts[set];
                            r();
                        }, 400));
                        changeSet(display, set, oldValue);
                        waiting = false;
                    }
                    const sliderChange = () => {
                        const value = (slider.value * 100).toFixed(0);
                        sliderText.text = value + '%';
                        oldValue = value;
                        limit();
                    };
                    slider.connect('notify::value', sliderChange);
                    menuItem.add_child(new St.Icon({
                        icon_name: `display-${set}-symbolic`,
                        style_class: 'system-status-icon2'
                    }));
                    menuItem.add_child(slider);
                    menuItem.add_child(sliderText);
                    this.menu.addMenuItem(menuItem);
                }
                let itemtitle = new PopupMenu.PopupBaseMenuItem({ activate: false });
                const title = new St.Label({ text: display.name });
                itemtitle.add_child(title);
                this.menu.addMenuItem(itemtitle);
                if (display.ddc) {
                    await makeSlider('brightness');
                    await makeSlider('contrast');
                }
            }
            getDisplays();
        }
        destroy() {
            displays.forEach(d => {
                Object.values(d.sliderTimeouts).forEach(timeout => clearTimeout(timeout));
                d.overlay.set_opacity(0);
                Main.uiGroup.remove_actor(d.overlay);
                d.overlay.destroy();
            });
            super.destroy();
        }
    }
);

class Extension {
    constructor(uuid) {
        this._uuid = uuid;
        ExtensionUtils.initTranslations(GETTEXT_DOMAIN);
    }
    enable() {
        this._indicator = new Indicator();
        Main.panel.addToStatusArea(this._uuid, this._indicator);
    }
    disable() {
        this._indicator.destroy();
        displays = [];
        this._indicator = null;
    }
}

function init(meta) {
    return new Extension(meta.uuid);
}

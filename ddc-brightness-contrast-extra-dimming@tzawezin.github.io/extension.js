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
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import { Slider } from 'resource:///org/gnome/shell/ui/slider.js';
import { Extension, gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
const ddcNrs = {
  brightness: '10',
  contrast: '12',
};
const ddcutil_path = '/usr/bin/ddcutil';
let displays = [];
let overviewHandlers = [];

function changeSet(display, set, value) {
  GLib.spawn_command_line_async(
    `${ddcutil_path} setvcp ${ddcNrs[set]} ${value} --bus ${display.bus}`
  );
}

async function getCmdOut(cmd) {
  return new Promise((resolve, reject) => {
    const process = Gio.Subprocess.new(
      cmd,
      Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE
    );
    process.communicate_utf8_async(null, null, (proc, res) => {
      try {
        const [, stdout, stderr] = process.communicate_utf8_finish(res);
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
      this.add_child(
        new St.Icon({
          icon_name: 'face-smile-symbolic',
          style_class: 'system-status-icon',
        })
      );
      overviewHandlers.push(Main.overview.connect('showing', this._onOverviewShowing));
      overviewHandlers.push(Main.overview.connect('hiding', this._onOverviewHiding));
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
          const display = {};
          display['ddc'] = !v.includes('Invalid');
          const arr = v.split('\n');
          display['i'] = i;
          const nameLine = arr.find((a) => a.includes('Monitor'));
          const busLine = arr.find((a) => a.includes('I2C bus'));
          display['name'] = nameLine.split(':')[2].trim() || 'monitor ' + (Number(display.i) + 1);
          display['bus'] = busLine.split('/dev/i2c-')[1].trim();
          display['sliderTimeouts'] = {};
          await newDisplayObj(display);
          newOverlaySlider(display);
          displays.push(display);
        }
      };

      const newOverlaySlider = (display) => {
        const item = new PopupMenu.PopupBaseMenuItem({ activate: false });
        const slider = new Slider(0);
        const sliderT = new St.Label({ text: '0%' });
        const monitors = [...Main.layoutManager.monitors];
        const monitor = monitors[(display.i + 1) % monitors.length];
        try {
          display.overlay = new Clutter.Actor({
            x: monitor.x,
            y: monitor.y,
            width: monitor.width,
            height: monitor.height,
            background_color: new Clutter.Color({
              red: 0,
              green: 0,
              blue: 0,
              alpha: 255,
            }),
            opacity: 0,
          });
          display.overlay.reactive = false;
        } catch (e) {
          logError(e, 'new Clutter.Actor');
          display.overlay = false;
        }

        Main.uiGroup.add_child(display.overlay);
        const sliderChange = () => {
          const value = slider.value * 100;
          sliderT.text = value.toFixed(0) + '%';
          display.overlay.set_opacity(value * 2.3);
          if (value) {
            if (!display.isOverlayActive && !display.isOverlayBlocked) {
              display.overlay && Main.uiGroup.add_actor(display.overlay);
            }
            display.isOverlayActive = true;
          } else {
            if (display.isOverlayActive && !display.isOverlayBlocked) {
              display.overlay && Main.uiGroup.remove_actor(display.overlay);
            }
            display.isOverlayActive = false;
          }
        };
        slider.connect('notify::value', sliderChange);
        item.add_child(slider);
        item.add_child(sliderT);
        this.menu.addMenuItem(item);
      };

      const newDisplayObj = async (display) => {
        const makeSlider = async (set) => {
          const menuItem = new PopupMenu.PopupBaseMenuItem({ activate: false });
          let oldValue = await getCmdOut([
            'ddcutil',
            'getvcp',
            '--brief',
            ddcNrs[set],
            '--bus',
            display.bus,
          ]);
          oldValue = Number(oldValue.split(' ')[3]);
          const slider = new Slider(oldValue / 100);
          const sliderText = new St.Label({ text: oldValue + '%' });
          let waiting = false;
          const limit = async () => {
            if (waiting) {
              return;
            }
            waiting = true;
            await new Promise(
              (r) =>
                (display.sliderTimeouts[set] = setTimeout(() => {
                  delete display.sliderTimeouts[set];
                  r();
                }, 400))
            );
            changeSet(display, set, oldValue);
            waiting = false;
          };

          const sliderChange = () => {
            const value = (slider.value * 100).toFixed(0);
            sliderText.text = value + '%';
            oldValue = value;
            limit();
          };
          slider.connect('notify::value', sliderChange);
          menuItem.add_child(
            new St.Icon({
              icon_name: `display-${set}-symbolic`,
              style_class: 'system-status-icon2',
            })
          );
          menuItem.add_child(slider);
          menuItem.add_child(sliderText);
          this.menu.addMenuItem(menuItem);
        };
        const itemtitle = new PopupMenu.PopupBaseMenuItem({ activate: false });
        const title = new St.Label({ text: display.name });
        itemtitle.add_child(title);
        this.menu.addMenuItem(itemtitle);
        if (display.ddc) {
          await makeSlider('brightness');
          await makeSlider('contrast');
        }
      };
      getDisplays();
    }

    _onOverviewShowing() {
      displays.forEach((d) => {
        d.isOverlayActive && d.overlay && Main.uiGroup.remove_actor(d.overlay);
        d.isOverlayBlocked = true;
      });
    }

    _onOverviewHiding() {
      displays.forEach((d) => {
        d.isOverlayActive && d.overlay && Main.uiGroup.add_actor(d.overlay);
        d.isOverlayBlocked = false;
      });
    }

    destroy() {
      displays.forEach((d) => {
        Object.values(d.sliderTimeouts).forEach((timeout) => clearTimeout(timeout));
        if (!d.overlay) {
          return;
        }
        d.overlay.set_opacity(0);
        d.isOverlayActive && !d.isOverlayBlocked && Main.uiGroup.remove_child(d.overlay);
        d.overlay.destroy();
      });
      overviewHandlers.forEach((h) => Main.overview.disconnect(h));
      super.destroy();
    }
  }
);

export default class MonitorDDCBrightnessContrastExtraDimmingExtension extends Extension {
  enable() {
    this._indicator = new Indicator();
    Main.panel.addToStatusArea(this._uuid, this._indicator);
  }
  disable() {
    this._indicator.destroy();
    displays = [];
    overviewHandlers = [];
    this._indicator = null;
  }
}

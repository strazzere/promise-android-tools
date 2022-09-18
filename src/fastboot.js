// @ts-check

/*
 * Copyright (C) 2017-2022 UBports Foundation <info@ubports.com>
 * Copyright (C) 2017-2022 Johannah Sprinz <hannah@ubports.com>
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */

import * as common from "./common.js";
import { Tool } from "./tool.js";

/**
 * fastboot android flashing and booting utility
 * @property {FasbootConfig} config fastboot config
 */
export class Fastboot extends Tool {
  constructor(options = {}) {
    super({
      tool: "fastboot",
      argsModel: {
        wipe: ["-w", false, true],
        device: ["-s", null],
        maxSize: ["-S", null],
        force: ["--force", false, true],
        slot: ["--slot", null],
        setActive: ["--set-active", null],
        skipSecondary: ["--skip-secondary", false, true],
        skipReboot: ["--skip-reboot", false, true],
        disableVerity: ["--disable-verity", false, true],
        disableVerification: ["--disable-verification", false, true],
        fsOptions: ["--fs-options", null],
        unbuffered: ["--unbuffered", false, true]
      },
      config: {
        wipe: false,
        device: null,
        maxSize: null,
        force: false,
        slot: null,
        setActive: null,
        skipSecondary: false,
        skipReboot: false,
        disableVerity: false,
        disableVerification: false,
        fsOptions: null,
        unbuffered: false
      },
      ...options
    });
  }

  /**
   * Generate processable error messages from child_process.exec() callbacks
   * @param {common.ExecException} error error returned by child_process.exec()
   * @param {String} stdout stdandard output
   * @param {String} stderr standard error
   * @returns {String} error message
   */
  handleError(error, stdout, stderr) {
    if (
      stderr?.includes("FAILED (remote: low power, need battery charging.)")
    ) {
      return "low battery";
    } else if (
      stderr?.includes("not supported in locked device") ||
      stderr?.includes("Bootloader is locked") ||
      stderr?.includes("not allowed in locked state") ||
      stderr?.includes("not allowed in Lock State") ||
      stderr?.includes("Device not unlocked cannot flash or erase") ||
      stderr?.includes("Partition flashing is not allowed") ||
      stderr?.includes("Command not allowed") ||
      stderr?.includes("not allowed when locked") ||
      stderr?.includes("device is locked. Cannot flash images") ||
      stderr?.match(/download for partition '[a-z]+' is not allowed/i)
    ) {
      return "bootloader locked";
    } else if (
      stderr?.includes("Check 'Allow OEM Unlock' in Developer Options") ||
      stderr?.includes("Unlock operation is not allowed") ||
      stderr?.includes("oem unlock is not allowed")
    ) {
      return "enable unlocking";
    } else if (stderr?.includes("FAILED (remote failure)")) {
      return "failed to boot";
    } else if (
      stderr?.includes("I/O error") ||
      stderr?.includes("FAILED (command write failed (No such device))") ||
      stderr?.includes("FAILED (command write failed (Success))") ||
      stderr?.includes("FAILED (status read failed (No such device))") ||
      stderr?.includes("FAILED (data transfer failure (Broken pipe))") ||
      stderr?.includes("FAILED (data transfer failure (Protocol error))")
    ) {
      return "no device";
    } else {
      return super.handleError(error, stdout, stderr);
    }
  }

  /**
   * @typedef FastbootFlashImage
   * @property {String} partition partition to flash
   * @property {String} file path to an image file
   * @property {Boolean} raw use `fastboot flash:raw` instead of `fastboot flash`
   * @property {Array<String>} flags additional cli-flags like --force and --disable-verification
   */

  /**
   * Write a file to a flash partition
   * @param {Array<FastbootFlashImage>} images Images to flash
   * @param {common.progressCallback} progress progress callback
   * @returns {Promise}
   */
  flash(images, progress = () => {}) {
    progress(0);
    const _this = this;
    // build a promise chain to flash all images sequentially
    return images
      .reduce(
        (prev, image, i) =>
          prev.then(
            () =>
              new Promise((resolve, reject) => {
                let stdout = "";
                let stderr = "";
                let offset = i / images.length;
                let scale = 1 / images.length;
                let sparseCurr = 1;
                let sparseTotal = 1;
                const cp = _this.spawn(
                  image.raw ? "flash:raw" : "flash",
                  image.partition,
                  ...(image?.flags || []),
                  image.file
                );
                cp.once("exit", (code, signal) => {
                  if (code || signal) {
                    reject(_this.handleError({ code, signal }, stdout, stderr));
                  } else {
                    resolve("");
                  }
                });
                cp?.stdout &&
                  cp.stdout.on("data", d => (stdout += d.toString()));
                cp?.stderr &&
                  cp.stderr.on("data", d => {
                    d.toString()
                      .trim()
                      .split("\n")
                      .forEach(str => {
                        // FIXME improve and simplify logic
                        if (!str.includes("OKAY")) {
                          if (str.includes("Sending")) {
                            try {
                              if (str.includes("sparse")) {
                                sparseCurr = parseInt(
                                  str.split("/")[0].split("' ")[1]
                                );
                                sparseTotal = parseInt(
                                  str.split("/")[1].split(" ")[0]
                                );
                              }
                            } catch {}
                            progress(
                              offset +
                                scale * ((sparseCurr * 0.3) / sparseTotal)
                            );
                          } else if (str.includes("Writing")) {
                            progress(
                              offset +
                                scale * ((sparseCurr * 0.9) / sparseTotal)
                            );
                          } else if (!str.includes("Finished")) {
                            stderr += str;
                          }
                        }
                      });
                  });
              })
          ),
        _this.wait()
      )
      .then(() => progress(1))
      .catch(e => {
        throw new Error(`Flashing failed: ${e}`);
      });
  }

  /**
   * Download and boot kernel
   * @param {String} image image file to boot
   * @returns {Promise}
   */
  boot(image) {
    return this.exec("boot", image)
      .then(() => null)
      .catch(error => {
        throw new Error("booting failed: " + error);
      });
  }

  /**
   * Reflash device from update.zip and set the flashed slot as active
   * @param {String} image image to flash
   * @param {String|Boolean} [wipe] wipe option
   * @returns {Promise}
   */
  update(image, wipe = false) {
    return this._withConfig({ wipe })
      .exec("update", image)
      .then(() => null)
      .catch(error => {
        throw new Error("update failed: " + error);
      });
  }

  /**
   * Reboot device into bootloader
   * @returns {Promise}
   */
  rebootBootloader() {
    return this.exec("reboot-bootloader")
      .then(() => null)
      .catch(error => {
        throw new Error("rebooting to bootloader failed: " + error);
      });
  }

  /**
   * Reboot device into userspace fastboot (fastbootd) mode
   * Note: this only works on devices which support dynamic partitions.
   * @returns {Promise}
   */
  rebootFastboot() {
    return this.exec("reboot-fastboot")
      .then(() => null)
      .catch(error => {
        throw new Error("rebooting to fastboot failed: " + error);
      });
  }

  /**
   * Reboot device into recovery
   * @returns {Promise}
   */
  rebootRecovery() {
    return this.exec("reboot-recovery")
      .then(() => null)
      .catch(error => {
        throw new Error("rebooting to recovery failed: " + error);
      });
  }

  /**
   * Reboot device
   * @returns {Promise}
   */
  reboot() {
    return this.exec("reboot")
      .then(() => null)
      .catch(error => {
        throw new Error("rebooting failed: " + error);
      });
  }

  /**
   * Continue with autoboot
   * @returns {Promise}
   */
  continue() {
    return this.exec("continue")
      .then(() => null)
      .catch(error => {
        throw new Error("continuing boot failed: " + error);
      });
  }

  /**
   * Format a flash partition. Can override the fs type and/or size the bootloader reports.
   * @param {String} partition to format
   * @param {String} type partition type
   * @param {String} size partition size
   * @returns {Promise}
   */
  format(partition, type, size) {
    if (!type && size) {
      return Promise.reject(
        new Error(
          "formatting failed: size specification requires type to be specified as well"
        )
      );
    }
    return this.exec(
      `format${type ? ":" + type : ""}${size ? ":" + size : ""}`,
      partition
    )
      .then(() => null)
      .catch(error => {
        throw new Error("formatting failed: " + error);
      });
  }

  /**
   * Erase a flash partition
   * @param {String} partition partition to erase
   * @returns {Promise}
   */
  erase(partition) {
    return this.exec("erase", partition)
      .then(() => null)
      .catch(error => {
        throw new Error("erasing failed: " + error);
      });
  }

  /**
   * Sets the active slot
   * @param {String} slot - slot to set as active
   */
  setActive(slot) {
    return this._withConfig({ setActive: slot })
      .exec()
      .then(stdout => {
        if (stdout && stdout.includes("error")) {
          throw new Error(stdout);
        } else {
          return;
        }
      })
      .catch(error => {
        throw new Error(`failed to set active slot: ${error}`);
      });
  }

  /**
   * Create a logical partition with the given name and size, in the super partition.
   * @param {String} partition - name of partition
   * @param {String} size - size in bytes
   * @returns {Promise}
   */
  createLogicalPartition(partition, size) {
    return this.exec("create-logical-partition", partition, size)
      .then(() => null)
      .catch(error => {
        throw new Error("creating logical partition failed: " + error);
      });
  }

  /**
   * Delete a logical partition with the given name.
   * @param {String} partition - name of partition
   * @returns {Promise}
   */
  deleteLogicalPartition(partition) {
    return this.exec("delete-logical-partition", partition)
      .then(() => null)
      .catch(error => {
        throw new Error("deleting logical partition failed: " + error);
      });
  }

  /**
   * Resize a logical partition with the given name and final size, in the super partition.
   * @param {String} partition - name of partition
   * @param {String} size - size in bytes
   * @returns {Promise}
   */
  resizeLogicalPartition(partition, size) {
    return this.exec("resize-logical-partition", partition, size)
      .then(() => null)
      .catch(error => {
        throw new Error("resizing logical partition failed: " + error);
      });
  }

  /**
   * Wipe the super partition and reset the partition layout
   * @param {String} image - super image containing the new partition layout
   * @returns {Promise}
   */
  wipeSuper(image) {
    return this.exec("wipe-super", image)
      .then(() => null)
      .catch(error => {
        throw new Error("wiping super failed: " + error);
      });
  }

  //////////////////////////////////////////////////////////////////////////////
  // Convenience functions
  //////////////////////////////////////////////////////////////////////////////

  /**
   * Lift OEM lock
   * @param {String} [code] optional unlock code (including 0x if necessary)
   * @returns {Promise}
   */
  oemUnlock(code = "") {
    return this.exec(...["oem", "unlock", code || []].flat())
      .then(() => null)
      .catch(error => {
        if (
          error?.message.includes("Already Unlocked") ||
          error?.message.includes("Not necessary")
        )
          return;
        else throw new Error("oem unlock failed: " + error);
      });
  }

  /**
   * Enforce OEM lock
   * @returns {Promise}
   */
  oemLock() {
    return this.exec("oem", "lock")
      .then(() => null)
      .catch(error => {
        throw new Error("oem lock failed: " + error);
      });
  }

  /**
   * lock partitions for flashing
   * @returns {Promise}
   */
  flashingLock() {
    return this.exec("flashing", "lock").then(() => null);
  }

  /**
   * unlock partitions for flashing
   * @returns {Promise}
   */
  flashingUnlock() {
    return this.exec("flashing", "unlock").then(() => null);
  }

  /**
   * lock 'critical' bootloader partitions
   * @returns {Promise}
   */
  flashingLockCritical() {
    return this.exec("flashing", "lock_critical").then(() => null);
  }

  /**
   * unlock 'critical' bootloader partitions
   * @returns {Promise}
   */
  flashingUnlockCritical() {
    return this.exec("flashing", "unlock_critical").then(() => null);
  }

  /**
   * Find out if a device can be flashing-unlocked
   * @returns {Promise<Boolean>}
   */
  getUnlockAbility() {
    return this.exec("flashing", "get_unlock_ability")
      .then(stdout => stdout?.trim() === "1")
      .catch(() => false);
  }

  /**
   * Find out if a device can be seen by fastboot
   * @returns {Promise}
   */
  hasAccess() {
    return this.exec("devices")
      .then(stdout => {
        return Boolean(stdout && stdout.includes("fastboot"));
      })
      .catch(error => {
        throw error;
      });
  }

  /**
   * Wait for a device
   * @returns {Promise<String>}
   */
  wait() {
    return super.wait().then(() => "bootloader");
  }

  /**
   * get bootloader var
   * @param {String} variable variable to get
   * @returns {Promise<String>} codename
   */
  async getvar(variable) {
    if (!(await this.hasAccess())) {
      throw new Error("no device");
    }

    const result = await this.exec("getvar", variable);
    const [name, value] = result
      .replace(/\r\n/g, "\n")
      .split("\n")[0]
      .split(": ");

    if (name !== variable) {
      throw new Error(`Unexpected getvar return: ${name}`);
    }

    return value;
  }

  /**
   * get device codename from product bootloader var
   * @returns {Promise<String>} codename
   */
  getDeviceName() {
    return this.getvar("product");
  }
}

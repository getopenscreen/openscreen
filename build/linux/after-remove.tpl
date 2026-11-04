#!/bin/bash

# Delete the link to the binary
# update-alternatives --remove <name> <path>: 'path' must be the registered alternative binary,
# not the generic symlink — see https://man7.org/linux/man-pages/man1/update-alternatives.1.html
if type update-alternatives >/dev/null 2>&1; then
    update-alternatives --remove '${executable}' '/opt/${sanitizedProductName}/${executable}'
else
    rm -f '/usr/bin/${executable}'
fi

APPARMOR_PROFILE_DEST='/etc/apparmor.d/${executable}'

# Remove and unload apparmor profile.
if [ -f "$APPARMOR_PROFILE_DEST" ]; then
  # Unload the profile from the running kernel before deleting the file so the
  # policy is not left enforced until the next reboot.  Mirror the chroot guard
  # used in the after-install script — live AppArmor operations are not
  # meaningful inside a chroot.
  # https://wiki.debian.org/AppArmor/HowToUse
  if apparmor_status --enabled > /dev/null 2>&1; then
    if ! { [ -x '/usr/bin/ischroot' ] && /usr/bin/ischroot; } && hash apparmor_parser 2>/dev/null; then
      apparmor_parser --remove "$APPARMOR_PROFILE_DEST" || true
    fi
  fi
  rm -f "$APPARMOR_PROFILE_DEST"
fi

# ---------------------------------------------------------------------------------------
# OpenScreen. Everything above is app-builder-lib's templates/linux/after-remove.tpl,
# verbatim: naming a script in electron-builder.json5 REPLACES that template instead of
# extending it. scripts/linux-package-scripts.test.mjs fails when the two drift apart.
#
# The package manager has already deleted 70-openscreen-pointer.rules by now. Reload so
# udev stops tagging pointer devices for uaccess, and replay a change event so the current
# devices are re-evaluated without it. An ACL logind already placed on a node can outlive
# this until the device is replugged or the machine reboots: udev has no event that
# withdraws one.
#
# This also runs on upgrade (deb postrm, rpm %postun), when the new package's copy of the
# rule is in place. Reloading then is harmless. Same guard as after-install.
if command -v udevadm >/dev/null 2>&1 && [ -S /run/udev/control ] \
    && ! { [ -x '/usr/bin/ischroot' ] && /usr/bin/ischroot; }; then
    udevadm control --reload-rules || true
    udevadm trigger --subsystem-match=input --action=change || true
fi

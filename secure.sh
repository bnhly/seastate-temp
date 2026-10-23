#!/bin/bash
# secure.sh - keep the Sea State data host patched (23 Oct 26).
#
# WHO RUNS IT: Ben, as root, from the Hetzner web console, one line at a time:
#
#   curl -fsSL -L raw.githubusercontent.com/bnhly/seastate-temp/kit/secure.sh -o secure.sh
#   bash secure.sh
#
# Safe to run again. What it does:
#   1. turns on Ubuntu's automatic updates (unattended-upgrades): security
#      fixes install by themselves every day, and when one needs a restart
#      (a new kernel) the server restarts itself at 16:00 UTC, about 3am in
#      Melbourne, which takes a minute or two
#   2. installs everything already waiting, now
#   3. stops nginx printing its version number on error pages
#   4. prints what the server listens on, so the firewall rules can be
#      checked against it
# It does not touch the firewall or SSH: those are set in the Hetzner
# console (Firewalls), where a mistake can be undone with a click.

set -u
if [ "$(id -u)" != 0 ]; then echo "run this as root"; exit 1; fi
export DEBIAN_FRONTEND=noninteractive
APT="apt-get -y -q -o Dpkg::Options::=--force-confold -o Dpkg::Options::=--force-confdef"

echo "=== secure.sh $(date -u) ==="

echo "1/4 automatic updates"
$APT update >/dev/null
$APT install unattended-upgrades >/dev/null
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'CONF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
CONF
cat > /etc/apt/apt.conf.d/52seastate-unattended <<'CONF'
// Sea State data host (secure.sh): restart by itself when an update needs
// it, at a quiet hour, and tidy old kernels so /boot never fills.
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-Time "16:00";
Unattended-Upgrade::Remove-Unused-Kernel-Packages "true";
Unattended-Upgrade::Remove-Unused-Dependencies "true";
CONF
timedatectl set-timezone Etc/UTC 2>/dev/null || true
systemctl enable --now unattended-upgrades >/dev/null 2>&1
systemctl enable --now apt-daily.timer apt-daily-upgrade.timer >/dev/null 2>&1

echo "2/4 installing waiting updates (can take a few minutes)"
$APT upgrade >/root/seastate/secure_upgrade.log 2>&1 && echo "    done" || echo "    upgrade reported a problem, see /root/seastate/secure_upgrade.log"
$APT autoremove >/dev/null 2>&1

echo "3/4 nginx version hidden"
echo "server_tokens off;" > /etc/nginx/conf.d/seastate-tokens.conf
if nginx -t >/dev/null 2>&1; then systemctl reload nginx; else rm -f /etc/nginx/conf.d/seastate-tokens.conf; echo "    skipped (nginx test failed)"; fi

echo "4/4 what this server listens on (should be nginx on 80 and 443, plus ssh on 22)"
ss -tlnH 2>/dev/null | awk '{print "    " $4}' | sort -u

echo
echo "CHECKS"
ok=1
chk() { if [ "$2" = 1 ]; then echo "    PASS  $1"; else echo "    FAIL  $1"; ok=0; fi; }
dpkg -s unattended-upgrades >/dev/null 2>&1; chk "unattended-upgrades installed" $([ $? = 0 ] && echo 1 || echo 0)
chk "unattended-upgrades service enabled" $([ "$(systemctl is-enabled unattended-upgrades 2>/dev/null)" = enabled ] && echo 1 || echo 0)
chk "daily update timer active" $([ "$(systemctl is-active apt-daily-upgrade.timer 2>/dev/null)" = active ] && echo 1 || echo 0)
chk "updates set to install daily" $(apt-config dump 2>/dev/null | grep -q 'APT::Periodic::Unattended-Upgrade "1"' && echo 1 || echo 0)
chk "automatic restart at 16:00" $(apt-config dump 2>/dev/null | grep -q 'Automatic-Reboot-Time "16:00"' && echo 1 || echo 0)
chk "server clock on UTC" $([ "$(date +%Z)" = UTC ] && echo 1 || echo 0)
chk "nginx running" $([ "$(systemctl is-active nginx 2>/dev/null)" = active ] && echo 1 || echo 0)
chk "certificate renewal timer active" $([ "$(systemctl is-active certbot.timer 2>/dev/null)" = active ] && echo 1 || echo 0)
SEC=$(apt-get -s upgrade 2>/dev/null | grep -c '^Inst .*-security')
chk "no security updates waiting ($SEC)" $([ "$SEC" = 0 ] && echo 1 || echo 0)
if [ "$ok" = 1 ]; then echo "SECURE CHECK: ALL PASS"; else echo "SECURE CHECK: SOMETHING FAILED (tell Claude which line)"; fi
echo
if [ -f /var/run/reboot-required ]; then
  echo "SECURE DONE. A restart is needed for the updates; it will happen by itself at 16:00 UTC."
  echo "To do it now instead, type:  reboot"
else
  echo "SECURE DONE. Up to date, no restart needed."
fi

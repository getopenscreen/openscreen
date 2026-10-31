# Home Manager module for OpenScreen
# Usage in flake-based Home Manager config:
#
#   inputs.openscreen.url = "github:EtienneLescot/openscreen";
#
#   { inputs, ... }: {
#     imports = [ inputs.openscreen.homeManagerModules.default ];
#     programs.openscreen.enable = true;
#   }
self:
{
  config,
  lib,
  pkgs,
  ...
}:

let
  cfg = config.programs.openscreen;
in
{
  options.programs.openscreen = {
    enable = lib.mkEnableOption "OpenScreen screen recorder";

    package = lib.mkOption {
      type = lib.types.package;
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.openscreen;
      defaultText = lib.literalExpression "inputs.openscreen.packages.\${pkgs.stdenv.hostPlatform.system}.openscreen";
      description = "The OpenScreen package to use.";
    };
  };

  config = lib.mkIf cfg.enable {
    # Home Manager cannot install udev rules, so click capture is not set up from
    # here: use the NixOS module (which adds the package's pointer rule to
    # services.udev.packages), or add `services.udev.packages = [ <the package> ];`
    # to the system configuration yourself. On a non-NixOS host, install the rule
    # by hand as website/docs/installation.md ("Mouse clicks on Wayland") shows.
    home.packages = [ cfg.package ];
  };
}

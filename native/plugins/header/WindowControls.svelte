<!--
  The header's right end: the build label, settings, then the window buttons. The buttons act on
  the window through svelte-gpui's window API. Minimise is optional because tiling compositors
  ignore it; the caller decides whether to offer it.
-->
<script lang="ts">
  import { window } from "@neoworks/svelte-gpui";
  import { Button, Icon, Text, Tooltip, View } from "@neoworks/svelte-gpui/ui";
  import cornersIn from "@phosphor-icons/core/regular/corners-in.svg";
  import cornersOut from "@phosphor-icons/core/regular/corners-out.svg";
  import gearSix from "@phosphor-icons/core/regular/gear-six.svg";
  import minus from "@phosphor-icons/core/regular/minus.svg";
  import x from "@phosphor-icons/core/regular/x.svg";
  import { colors, fontSize, iconButton, iconButtonHover, size } from "../theme/tokens";

  interface Props {
    /** Which build this is, e.g. `v0.4.0 · 253fd9ac`. */
    versionLabel?: string;
    canMinimize?: boolean;
    onsettings?: () => void;
  }

  let { versionLabel, canMinimize = true, onsettings }: Props = $props();

  const fullscreenLabel = $derived(window.fullscreen ? "Exit full screen" : "Full screen");

  /** The look shared by the settings and window buttons. */
  const buttonStyle = {
    ...iconButton,
    width: size.windowButtonWidth,
    height: size.windowButtonHeight,
  };
</script>

<View style={{ direction: "row", align: "center", gap: 2 }}>
  {#if versionLabel}
    <Text style={{ marginRight: 4, fontFamily: "mono", fontSize: fontSize.xxs, color: colors.dim }}>{versionLabel}</Text>
  {/if}
  <Tooltip text="Settings">
    <Button style={buttonStyle} hover={iconButtonHover} onpress={() => onsettings?.()}>
      <Icon svg={gearSix} size={15} />
    </Button>
  </Tooltip>
  <View style={{ width: 1, height: 14, marginX: 4, background: colors.lineFaint }} />
  {#if canMinimize}
    <Tooltip text="Minimize">
      <Button style={buttonStyle} hover={iconButtonHover} onpress={() => window.minimize()}>
        <Icon svg={minus} size={15} />
      </Button>
    </Tooltip>
  {/if}
  <Tooltip text={fullscreenLabel}>
    <Button style={buttonStyle} hover={iconButtonHover} onpress={() => window.toggleFullscreen()}>
      <Icon svg={window.fullscreen ? cornersIn : cornersOut} size={15} />
    </Button>
  </Tooltip>
  <Tooltip text="Close">
    <Button style={buttonStyle} hover={{ background: colors.redSoft, color: colors.red }} onpress={() => window.close()}>
      <Icon svg={x} size={15} />
    </Button>
  </Tooltip>
</View>

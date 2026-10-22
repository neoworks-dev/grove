<script lang="ts" module>
  import type { Component as SvelteComponent } from "svelte";
  import type { UiNode } from "@suite/protocol/types";
  import AccordionNode from "./AccordionNode.svelte";
  import BarChartNode from "./BarChartNode.svelte";
  import BoxNode from "./BoxNode.svelte";
  import ButtonNode from "./ButtonNode.svelte";
  import ButtonsNode from "./ButtonsNode.svelte";
  import CalloutNode from "./CalloutNode.svelte";
  import CardNode from "./CardNode.svelte";
  import CarouselNode from "./CarouselNode.svelte";
  import CheckBoxNode from "./CheckBoxNode.svelte";
  import CodeNode from "./CodeNode.svelte";
  import DateNode from "./DateNode.svelte";
  import EntityListNode from "./EntityListNode.svelte";
  import FollowUpNode from "./FollowUpNode.svelte";
  import FormControlNode from "./FormControlNode.svelte";
  import FormNode from "./FormNode.svelte";
  import GalleryNode from "./GalleryNode.svelte";
  import GridNode from "./GridNode.svelte";
  import GroupNode from "./GroupNode.svelte";
  import HeaderNode from "./HeaderNode.svelte";
  import ImageNode from "./ImageNode.svelte";
  import IndicatorNode from "./IndicatorNode.svelte";
  import KeyValueNode from "./KeyValueNode.svelte";
  import LineChartNode from "./LineChartNode.svelte";
  import LinkNode from "./LinkNode.svelte";
  import ListNode from "./ListNode.svelte";
  import MetricNode from "./MetricNode.svelte";
  import OptionCardsNode from "./OptionCardsNode.svelte";
  import PieChartNode from "./PieChartNode.svelte";
  import ProgressNode from "./ProgressNode.svelte";
  import RadioNode from "./RadioNode.svelte";
  import SelectNode from "./SelectNode.svelte";
  import SeparatorNode from "./SeparatorNode.svelte";
  import ShapeNode from "./ShapeNode.svelte";
  import SparklineNode from "./SparklineNode.svelte";
  import SliderNode from "./SliderNode.svelte";
  import StackNode from "./StackNode.svelte";
  import StepsNode from "./StepsNode.svelte";
  import SwitchNode from "./SwitchNode.svelte";
  import TableNode from "./TableNode.svelte";
  import TabsNode from "./TabsNode.svelte";
  import TagNode from "./TagNode.svelte";
  import TextField from "./TextField.svelte";
  import TextNode from "./TextNode.svelte";

  export interface NodeProps {
    node: UiNode;
    /** Where the node sits in the doc: names what has no key. */
    path: string;
    /** Pixels it may take. */
    width: number;
    /** In a row of cards: take the row's height. */
    fill?: boolean;
  }

  /** The component that draws each library component. */
  const DRAWN: Record<string, SvelteComponent<NodeProps>> = {
    Card: CardNode,
    Text: TextNode,
    Stack: StackNode,
    Grid: GridNode,
    Carousel: CarouselNode,
    Header: HeaderNode,
    // It has nothing to read from its node.
    Separator: SeparatorNode as unknown as SvelteComponent<NodeProps>,
    Tabs: TabsNode,
    Accordion: AccordionNode,
    Steps: StepsNode,
    Box: BoxNode,
    Shape: ShapeNode,
    Code: CodeNode,
    Table: TableNode,
    List: ListNode,
    KeyValue: KeyValueNode,
    Tag: TagNode,
    EntityList: EntityListNode,
    Callout: CalloutNode,
    Metric: MetricNode,
    MetricIndicator: IndicatorNode,
    Progress: ProgressNode,
    Image: ImageNode,
    ImageGallery: GalleryNode,
    Link: LinkNode,
    BarChart: BarChartNode,
    LineChart: LineChartNode,
    AreaChart: LineChartNode,
    PieChart: PieChartNode,
    Sparkline: SparklineNode,
    FollowUpBlock: FollowUpNode,
    Form: FormNode,
    FormControl: FormControlNode,
    Input: TextField,
    TextArea: TextField,
    DatePicker: DateNode,
    Select: SelectNode,
    RadioGroup: RadioNode,
    OptionCards: OptionCardsNode,
    CheckBox: CheckBoxNode,
    Switch: SwitchNode,
    CheckBoxGroup: GroupNode,
    SwitchGroup: GroupNode,
    Slider: SliderNode,
    Button: ButtonNode,
    Buttons: ButtonsNode,
  };
</script>

<script lang="ts">
  // One evaluated component, drawn by the component that knows it. A name the window does not know
  // is a muted line, as in the terminal.
  import { Text } from "@neoworks/svelte-gpui/ui";
  import { neouiPalette } from "./look";

  let { node, path, width, fill = false }: NodeProps = $props();
  const p = neouiPalette;
  const Drawn = $derived(DRAWN[node.component]);
</script>

{#if Drawn}
  <Drawn {node} {path} {width} {fill} />
{:else}
  <Text style={{ color: p.muted }}>[unsupported: {node.component}]</Text>
{/if}

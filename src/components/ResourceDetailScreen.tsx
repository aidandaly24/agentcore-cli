import { useCallback, useEffect, useRef, useState } from "react";
import { Box, Text, measureElement, useInput, useWindowSize, type DOMElement } from "ink";
import { ScrollView, type ScrollViewRef } from "ink-scroll-view";
import { useNavigate } from "react-router";
import { KeyValueTable } from "./KeyValueTable.js";
import { Layout } from "./Layout";
import { hasNestedRows, LinkedResourcesTree, type LinkedResourceNode } from "./LinkedResources";
import { darkTheme, glyphs } from "./ui/_core.js";
import { Divider } from "./ui/divider/Divider.js";
import { Spinner } from "./ui/spinner";

export interface ResourceDetailAction {
  name: string;
  description: string;
  onSelect: () => void;
}

export interface ResourceDetailLinkedResources {
  nodes: LinkedResourceNode[];
  /** Divider title above the tree; defaults to "linked resources". */
  title?: string;
}

export interface ResourceDetailScreenProps {
  breadcrumb: string[];
  isPending: boolean;
  error: Error | null;
  items: Record<string, string>;
  actions: ResourceDetailAction[];
  loadingLabel: string;
  onRetry?: () => void;
  selectLabel?: string;
  /**
   * An optional Linked Resources tree under the actions (see
   * LinkedResourcesTree). The action list and the tree behave as one
   * continuous list: down from the last action moves into the tree, up from
   * the tree's first row comes back, and only the focused zone shows the ❯
   * marker.
   */
  linkedResources?: ResourceDetailLinkedResources;
}

type FocusZone = "actions" | "linked";

export function ResourceDetailScreen({
  breadcrumb,
  isPending,
  error,
  items,
  actions,
  loadingLabel,
  onRetry,
  selectLabel = "select",
  linkedResources,
}: ResourceDetailScreenProps) {
  const navigate = useNavigate();
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [zone, setZone] = useState<FocusZone>("actions");
  const [focusedRow, setFocusedRow] = useState<DOMElement | null>(null);
  const viewportRef = useRef<DOMElement>(null);
  const scrollRef = useRef<ScrollViewRef>(null);
  const { columns, rows } = useWindowSize();
  const ready = !isPending && !error;

  const linkedNodes = linkedResources?.nodes ?? [];
  const hasLinked = ready && linkedNodes.length > 0;
  // With no actions to focus, the tree is the only list and owns the keys.
  const linkedFocused = hasLinked && (zone === "linked" || actions.length === 0);

  const scrollBy = useCallback((delta = 0, contentHeight?: number) => {
    const scroll = scrollRef.current;
    const viewport = viewportRef.current;
    if (!scroll || !viewport) return;
    const height = measureElement(viewport).height;
    const bottom = Math.max(0, (contentHeight ?? scroll.getContentHeight()) - height);
    scroll.scrollTo(Math.max(0, Math.min(scroll.getScrollOffset() + delta, bottom)));
  }, []);

  const keepFocusVisible = useCallback(() => {
    const scroll = scrollRef.current;
    const viewport = viewportRef.current;
    if (!scroll || !viewport) return;
    if (!focusedRow) return;
    const row = measureElement(focusedRow);
    const bounds = measureElement(viewport);
    const unscrolledBottom = row.y - bounds.y + row.height + scroll.getScrollOffset();
    // Restore the summary with the first action only when both fit.
    if (!linkedFocused && selectedIndex === 0 && unscrolledBottom <= bounds.height) {
      scroll.scrollToTop();
      return;
    }
    if (row.y < bounds.y) scrollBy(row.y - bounds.y);
    else if (row.y + row.height > bounds.y + bounds.height) {
      scrollBy(row.y + Math.min(row.height, bounds.height) - bounds.y - bounds.height);
    }
  }, [focusedRow, linkedFocused, selectedIndex, scrollBy]);

  useEffect(() => {
    keepFocusVisible();
  }, [keepFocusVisible, columns, rows, ready]);

  useInput((input, key) => {
    if (key.escape) {
      navigate(-1);
      return;
    }
    if (input === "r" && error && onRetry) {
      onRetry();
      return;
    }
    if (ready && (key.pageUp || key.pageDown)) {
      scrollBy((key.pageUp ? -1 : 1) * (scrollRef.current?.getViewportHeight() ?? 0));
      return;
    }
    // Boundary navigation may keep the same selection after paging it out of view.
    if (
      ready &&
      (key.upArrow ||
        key.downArrow ||
        key.leftArrow ||
        key.rightArrow ||
        ["j", "k", "h", "l", "g", "G", " "].includes(input))
    ) {
      keepFocusVisible();
    }
    // While the tree is focused it handles its own keys (and reports up from
    // its first row through onUpFromFirst).
    if (!ready || linkedFocused || actions.length === 0) return;
    if (key.upArrow || input === "k") {
      setSelectedIndex((current) => Math.max(0, current - 1));
      return;
    }
    if (key.downArrow || input === "j") {
      if (hasLinked && selectedIndex === actions.length - 1) {
        setZone("linked");
        return;
      }
      setSelectedIndex((current) => Math.min(actions.length - 1, current + 1));
      return;
    }
    if (key.return) actions[selectedIndex]?.onSelect();
  });

  const nameWidth = actions.reduce((width, action) => Math.max(width, action.name.length), 0) + 3;
  const navigable = ready && (actions.length > 1 || hasLinked);
  const selectable = ready && (actions.length > 0 || hasLinked);

  return (
    <Layout
      breadcrumb={breadcrumb}
      keyHints={[
        ...(navigable ? [{ key: "↑↓/jk", label: "navigate" }] : []),
        ...(linkedFocused && hasNestedRows(linkedNodes)
          ? [{ key: "←→", label: "collapse/expand" }]
          : []),
        ...(selectable ? [{ key: "enter", label: linkedFocused ? "open" : selectLabel }] : []),
        ...(ready ? [{ key: "pgup/pgdn", label: "scroll" }] : []),
        ...(error && onRetry ? [{ key: "r", label: "retry" }] : []),
        { key: "esc", label: "back" },
        { key: "ctrl+c", label: "quit" },
      ]}
    >
      {isPending ? (
        <Spinner label={loadingLabel} />
      ) : error ? (
        <Text color="red">Error: {error.message}</Text>
      ) : (
        <Box ref={viewportRef} flexDirection="column" flexGrow={1} minHeight={0}>
          <ScrollView
            ref={scrollRef}
            flexGrow={1}
            minHeight={0}
            onViewportSizeChange={() => {
              scrollBy();
              keepFocusVisible();
            }}
            onContentHeightChange={(height) => {
              scrollBy(0, height);
              keepFocusVisible();
            }}
          >
            <Box flexDirection="column">
              <Box flexDirection="column" paddingLeft={1}>
                <KeyValueTable items={items} />
              </Box>

              {actions.length > 0 && (
                <>
                  <Divider />

                  <Box flexDirection="column" paddingLeft={1}>
                    {actions.map((action, actionIndex) => {
                      const selected = actionIndex === selectedIndex && !linkedFocused;
                      return (
                        <Box key={action.name} ref={selected ? setFocusedRow : undefined}>
                          <Text color={darkTheme.colors.focus}>
                            {selected ? `${glyphs.pointer} ` : "  "}
                          </Text>
                          <Text
                            bold={selected}
                            color={selected ? darkTheme.colors.focus : darkTheme.colors.text}
                          >
                            {action.name.padEnd(nameWidth)}
                          </Text>
                          <Text color={darkTheme.colors.muted}>{action.description}</Text>
                        </Box>
                      );
                    })}
                  </Box>
                </>
              )}

              {hasLinked && (
                <LinkedResourcesTree
                  nodes={linkedNodes}
                  title={linkedResources?.title}
                  focus={linkedFocused}
                  onUpFromFirst={actions.length > 0 ? () => setZone("actions") : undefined}
                  focusedRowRef={setFocusedRow}
                  onContentChange={() => scrollRef.current?.remeasureItem(0)}
                  onOpen={(route) => navigate(route)}
                />
              )}
            </Box>
          </ScrollView>
        </Box>
      )}
    </Layout>
  );
}

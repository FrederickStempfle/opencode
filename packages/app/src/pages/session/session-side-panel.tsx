import { For, Match, Show, Switch, createEffect, createMemo, createSignal, on, onCleanup, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { createMediaQuery } from "@solid-primitives/media"
import { Tabs } from "@opencode-ai/ui/tabs"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { Icon } from "@opencode-ai/ui/icon"
import { TooltipKeybind } from "@opencode-ai/ui/tooltip"
import { ResizeHandle } from "@opencode-ai/ui/resize-handle"
import { Mark } from "@opencode-ai/ui/logo"
import { DragDropProvider, DragDropSensors, DragOverlay, SortableProvider, closestCenter } from "@thisbeyond/solid-dnd"
import type { DragEvent } from "@thisbeyond/solid-dnd"
import type { SnapshotFileDiff, VcsFileDiff } from "@opencode-ai/sdk/v2"
import { ConstrainDragYAxis, getDraggableId } from "@/utils/solid-dnd"
import { useDialog } from "@opencode-ai/ui/context/dialog"

import FileTree from "@/components/file-tree"
import { SessionContextUsage } from "@/components/session-context-usage"
import { SessionContextTab, SortableTab, FileVisual } from "@/components/session"
import { useCommand } from "@/context/command"
import { useFile, type SelectedLineRange } from "@/context/file"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { useSettings } from "@/context/settings"
import { useTerminal } from "@/context/terminal"
import { useSync } from "@/context/sync"
import { createFileTabListSync } from "@/pages/session/file-tab-scroll"
import { FileTabContent } from "@/pages/session/file-tabs"
import {
  createDelayedTrue,
  createOpenSessionFileTab,
  createSessionTabs,
  createStickyOpen,
  getTabReorderIndex,
  PANEL_ANIMATION_MS,
  shouldShowFileTree,
  type Sizing,
} from "@/pages/session/helpers"
import { setSessionHandoff } from "@/pages/session/handoff"
import { useSessionLayout } from "@/pages/session/session-layout"
import { terminalTabLabel } from "@/pages/session/terminal-label"
import { TerminalView } from "@/pages/session/terminal-view"

type RenderDiff = (SnapshotFileDiff & { file: string }) | VcsFileDiff

function renderDiff(value: SnapshotFileDiff | VcsFileDiff): value is RenderDiff {
  return typeof value.file === "string"
}

export function SessionSidePanel(props: {
  canReview: () => boolean
  diffs: () => (SnapshotFileDiff | VcsFileDiff)[]
  diffsReady: () => boolean
  empty: () => string
  hasReview: () => boolean
  reviewCount: () => number
  reviewPanel: () => JSX.Element
  activeDiff?: string
  focusReviewDiff: (path: string) => void
  size: Sizing
}) {
  const layout = useLayout()
  const settings = useSettings()
  const terminal = useTerminal()
  const sync = useSync()
  const file = useFile()
  const language = useLanguage()
  const command = useCommand()
  const dialog = useDialog()
  const { sessionKey, tabs, view, params } = useSessionLayout()

  const isDesktop = createMediaQuery("(min-width: 768px)")
  const shown = settings.visibility.fileTree

  const reviewOpen = createMemo(() => isDesktop() && view().reviewPanel.opened())
  const fileOpen = createMemo(
    () =>
      isDesktop() &&
      shouldShowFileTree({
        visible: shown(),
        opened: layout.fileTree.opened(),
      }),
  )
  const open = createMemo(() => reviewOpen() || fileOpen())
  const reviewTab = createMemo(() => isDesktop())

  // `open` flips immediately and drives the GPU transform/opacity slide.
  // The "expanded" stickies keep the absolute panel mounted and sized until the
  // content has slid out, so the chat column's width snaps once per toggle
  // instead of reflowing the message timeline on every animation frame.
  const reviewExpanded = createStickyOpen(reviewOpen, PANEL_ANIMATION_MS)
  const fileExpanded = createStickyOpen(fileOpen, PANEL_ANIMATION_MS)
  const expanded = createMemo(() => reviewExpanded() || fileExpanded())
  // `settled` is true only while the panel sits fully open and still. Then it's a
  // normal in-flow flex item (flush, like the original); during the open/close
  // slide it becomes an absolute overlay so it can move without reserving a slot.
  const settled = createDelayedTrue(open, PANEL_ANIMATION_MS)

  // Drives the slide direction. On open the content mounts off-screen, then this
  // flips `true` after the closed state has painted (double rAF) so the transition
  // animates in. On close it flips `false` immediately to slide back out.
  const [slideIn, setSlideIn] = createSignal(false)
  createEffect(() => {
    if (!open()) {
      setSlideIn(false)
      return
    }
    let inner = 0
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => setSlideIn(true))
    })
    onCleanup(() => {
      cancelAnimationFrame(outer)
      if (inner) cancelAnimationFrame(inner)
    })
  })
  // When settled and in-flow, review mode is sized by flex-1 (width auto). While
  // animating it's an absolute overlay, so it needs an explicit width: the slice
  // to the right of the chat column. In the new layout that subtracts the row's
  // left padding, the card gap, and the right padding (3 × 0.5rem) so the overlay
  // lines up exactly with the in-flow card. The file tree uses its fixed width.
  const panelWidth = createMemo(() => {
    if (fileExpanded()) return `${layout.fileTree.width()}px`
    if (!reviewExpanded()) return "0px"
    if (settled()) return "auto"
    const inset = settings.general.newLayoutDesigns() ? " - 1.5rem" : ""
    return `calc(100% - ${layout.session.width()}px${inset})`
  })
  const treeWidth = createMemo(() => (fileExpanded() ? `${layout.fileTree.width()}px` : "0px"))

  const diffs = createMemo(() => props.diffs().filter(renderDiff))
  const diffFiles = createMemo(() => diffs().map((d) => d.file))
  const kinds = createMemo(() => {
    const merge = (a: "add" | "del" | "mix" | undefined, b: "add" | "del" | "mix") => {
      if (!a) return b
      if (a === b) return a
      return "mix" as const
    }

    const normalize = (p: string) => p.replaceAll("\\\\", "/").replace(/\/+$/, "")

    const out = new Map<string, "add" | "del" | "mix">()
    for (const diff of diffs()) {
      const file = normalize(diff.file)
      const kind = diff.status === "added" ? "add" : diff.status === "deleted" ? "del" : "mix"

      out.set(file, kind)

      const parts = file.split("/")
      for (const [idx] of parts.slice(0, -1).entries()) {
        const dir = parts.slice(0, idx + 1).join("/")
        if (!dir) continue
        out.set(dir, merge(out.get(dir), kind))
      }
    }
    return out
  })

  const empty = (msg: string) => (
    <div class="h-full flex flex-col">
      <div class="h-6 shrink-0" aria-hidden />
      <div class="flex-1 pb-64 flex items-center justify-center text-center">
        <div class="text-12-regular text-text-weak">{msg}</div>
      </div>
    </div>
  )

  const nofiles = createMemo(() => {
    const state = file.tree.state("")
    if (!state?.loaded) return false
    return file.tree.children("").length === 0
  })

  const normalizeTab = (tab: string) => {
    if (!tab.startsWith("file://")) return tab
    return file.tab(tab)
  }

  const openReviewPanel = () => {
    if (!view().reviewPanel.opened()) view().reviewPanel.open()
  }

  const terminalFocused = createMemo(() => view().terminal.opened())

  const addTerminal = () => {
    terminal.new()
    openReviewPanel()
    view().terminal.open()
  }

  const selectTerminal = (id: string) => {
    terminal.open(id)
    openReviewPanel()
    if (!view().terminal.opened()) view().terminal.open()
  }

  const newDiff = () => {
    void import("@/components/dialog-select-file").then((x) => {
      dialog.show(() => <x.DialogSelectFile mode="files" onOpenFile={showAllFiles} />)
    })
  }

  const openTab = createOpenSessionFileTab({
    normalizeTab,
    openTab: tabs().open,
    pathFromTab: file.pathFromTab,
    loadFile: file.load,
    openReviewPanel,
    setActive: tabs().setActive,
  })

  const tabState = createSessionTabs({
    tabs,
    pathFromTab: file.pathFromTab,
    normalizeTab,
    review: reviewTab,
    hasReview: props.canReview,
  })
  const contextOpen = tabState.contextOpen
  const openedTabs = tabState.openedTabs
  const activeTab = tabState.activeTab
  const activeFileTab = tabState.activeFileTab

  const terminalTab = (id: string) => `terminal:${id}`

  const activeView = createMemo(() => {
    const active = terminal.active()
    if (terminalFocused() && active) return terminalTab(active)
    return activeTab()
  })

  const selectTab = (value: string) => {
    if (value.startsWith("terminal:")) {
      selectTerminal(value.slice("terminal:".length))
      return
    }
    if (view().terminal.opened()) view().terminal.close()
    openTab(value)
  }

  // surface the review panel whenever the terminal becomes the active view
  createEffect(
    on(terminalFocused, (open, prev) => {
      if (open && !prev) openReviewPanel()
    }),
  )

  // create a terminal when the panel is focused with none open
  createEffect(() => {
    if (!terminalFocused()) return
    if (!terminal.ready()) return
    if (terminal.all().length > 0) return
    terminal.new()
  })

  // drop terminal focus once the last terminal closes
  createEffect(
    on(
      () => terminal.all().length,
      (count, prev) => {
        if (prev === undefined || prev <= 0 || count !== 0) return
        if (view().terminal.opened()) view().terminal.close()
      },
    ),
  )

  const fileTreeTab = () => layout.fileTree.tab()

  const setFileTreeTabValue = (value: string) => {
    if (value !== "changes" && value !== "all") return
    layout.fileTree.setTab(value)
  }

  const showAllFiles = () => {
    if (fileTreeTab() !== "changes") return
    layout.fileTree.setTab("all")
  }

  const [store, setStore] = createStore({
    activeDraggable: undefined as string | undefined,
  })

  const handleDragStart = (event: unknown) => {
    const id = getDraggableId(event)
    if (!id) return
    setStore("activeDraggable", id)
  }

  const handleDragOver = (event: DragEvent) => {
    const { draggable, droppable } = event
    if (!draggable || !droppable) return

    const currentTabs = tabs().all()
    const toIndex = getTabReorderIndex(currentTabs, draggable.id.toString(), droppable.id.toString())
    if (toIndex === undefined) return
    tabs().move(draggable.id.toString(), toIndex)
  }

  const handleDragEnd = () => {
    setStore("activeDraggable", undefined)
  }

  createEffect(() => {
    if (!file.ready()) return

    setSessionHandoff(sessionKey(), {
      files: tabs()
        .all()
        .reduce<Record<string, SelectedLineRange | null>>((acc, tab) => {
          const path = file.pathFromTab(tab)
          if (!path) return acc

          const selected = file.selectedLines(path)
          acc[path] =
            selected && typeof selected === "object" && "start" in selected && "end" in selected
              ? (selected as SelectedLineRange)
              : null

          return acc
        }, {}),
    })
  })

  return (
    <Show when={isDesktop() && !(settings.general.newLayoutDesigns() && !params.id)}>
      <aside
        id="review-panel"
        aria-label={language.t("session.panel.reviewAndFiles")}
        aria-hidden={!open()}
        inert={!open()}
        class="min-w-0 flex overflow-hidden bg-background-base [backface-visibility:hidden]"
        classList={{
          // settled → normal flush flex item; animating → absolute overlay so it
          // can slide without leaving a reserved (black) slot behind. The overlay
          // insets match the row's p-2 padding so it lines up with the in-flow card.
          "relative h-full shrink-0": settled(),
          "flex-1": settled() && reviewExpanded(),
          "absolute z-20": !settled(),
          "inset-y-0 right-0": !settled() && !settings.general.newLayoutDesigns(),
          "inset-y-2 right-2": !settled() && settings.general.newLayoutDesigns(),
          "pointer-events-none": !open(),
          "rounded-[10px] shadow-[var(--v2-elevation-raised)] overflow-hidden": settings.general.newLayoutDesigns(),
          "transition-[translate] duration-[240ms] ease-[cubic-bezier(0.32,0.72,0,1)] will-change-[translate] motion-reduce:transition-none":
            !props.size.active() && !settled(),
          "translate-x-full": !slideIn(),
          "translate-x-0": slideIn(),
        }}
        style={{ width: panelWidth() }}
      >
        <Show when={expanded()}>
          <div
            class="size-full flex"
            classList={{
              "border-l border-border-weaker-base": !settings.general.newLayoutDesigns(),
            }}
          >
            <div
              aria-hidden={!reviewOpen()}
              inert={!reviewOpen()}
              class="relative min-w-0 h-full flex-1 overflow-hidden bg-background-base"
              classList={{
                "pointer-events-none": !reviewOpen(),
              }}
            >
              <div class="size-full min-w-0 h-full bg-background-base">
                <DragDropProvider
                  onDragStart={handleDragStart}
                  onDragEnd={handleDragEnd}
                  onDragOver={handleDragOver}
                  collisionDetector={closestCenter}
                >
                  <DragDropSensors />
                  <ConstrainDragYAxis />
                  <Tabs value={activeView()} onChange={selectTab}>
                    <div class="sticky top-0 shrink-0 flex">
                      <Tabs.List
                        ref={(el: HTMLDivElement) => {
                          const stop = createFileTabListSync({ el, contextOpen })
                          onCleanup(stop)
                        }}
                      >
                        <Show when={reviewTab() && props.canReview()}>
                          <Tabs.Trigger value="review">
                            <div class="flex items-center gap-1.5">
                              <div>{language.t("session.tab.review")}</div>
                              <Show when={props.hasReview()}>
                                <div>{props.reviewCount()}</div>
                              </Show>
                            </div>
                          </Tabs.Trigger>
                        </Show>
                        <For each={terminal.all()}>
                          {(pty) => (
                            <Tabs.Trigger
                              value={terminalTab(pty.id)}
                              closeButton={
                                <IconButton
                                  icon="close-small"
                                  variant="ghost"
                                  class="h-5 w-5"
                                  onClick={() => terminal.close(pty.id)}
                                  aria-label={language.t("common.closeTab")}
                                />
                              }
                              hideCloseButton
                              onMiddleClick={() => terminal.close(pty.id)}
                            >
                              <div>
                                {terminalTabLabel({
                                  title: pty.title,
                                  titleNumber: pty.titleNumber,
                                  t: language.t as (
                                    key: string,
                                    vars?: Record<string, string | number | boolean>,
                                  ) => string,
                                })}
                              </div>
                            </Tabs.Trigger>
                          )}
                        </For>
                        <Show when={contextOpen()}>
                          <Tabs.Trigger
                            value="context"
                            closeButton={
                              <TooltipKeybind
                                title={language.t("common.closeTab")}
                                keybind={command.keybind("tab.close")}
                                placement="bottom"
                                gutter={10}
                              >
                                <IconButton
                                  icon="close-small"
                                  variant="ghost"
                                  class="h-5 w-5"
                                  onClick={() => tabs().close("context")}
                                  aria-label={language.t("common.closeTab")}
                                />
                              </TooltipKeybind>
                            }
                            hideCloseButton
                            onMiddleClick={() => tabs().close("context")}
                          >
                            <div class="flex items-center gap-2">
                              <SessionContextUsage variant="indicator" />
                              <div>{language.t("session.tab.context")}</div>
                            </div>
                          </Tabs.Trigger>
                        </Show>
                        <SortableProvider ids={openedTabs()}>
                          <For each={openedTabs()}>{(tab) => <SortableTab tab={tab} onTabClose={tabs().close} />}</For>
                        </SortableProvider>
                        <div class="bg-background-stronger h-full shrink-0 sticky right-0 z-10 flex items-center justify-center pr-3">
                          <DropdownMenu gutter={4} placement="bottom-end">
                            <DropdownMenu.Trigger
                              as={IconButton}
                              icon="plus-small"
                              variant="ghost"
                              iconSize="large"
                              class="!rounded-md"
                              aria-label={language.t("session.panel.add")}
                            />
                            <DropdownMenu.Portal>
                              <DropdownMenu.Content>
                                <DropdownMenu.Item onSelect={addTerminal}>
                                  <Icon name="terminal-active" class="size-4" />
                                  <span data-slot="dropdown-menu-item-label">
                                    {language.t("session.panel.addTerminal")}
                                  </span>
                                </DropdownMenu.Item>
                                <DropdownMenu.Item onSelect={newDiff}>
                                  <Icon name="plus-small" class="size-4" />
                                  <span data-slot="dropdown-menu-item-label">
                                    {language.t("session.panel.newDiff")}
                                  </span>
                                </DropdownMenu.Item>
                              </DropdownMenu.Content>
                            </DropdownMenu.Portal>
                          </DropdownMenu>
                        </div>
                      </Tabs.List>
                    </div>

                    <Show when={reviewTab() && props.canReview()}>
                      <Tabs.Content value="review" class="flex flex-col h-full overflow-hidden contain-strict">
                        <Show when={reviewOpen() && activeTab() === "review"}>{props.reviewPanel()}</Show>
                      </Tabs.Content>
                    </Show>

                    <For each={terminal.all()}>
                      {(pty) => (
                        <Tabs.Content
                          value={terminalTab(pty.id)}
                          class="flex flex-col h-full overflow-hidden contain-strict"
                        >
                          <Show when={activeView() === terminalTab(pty.id)}>
                            <TerminalView pty={pty} active={() => activeView() === terminalTab(pty.id)} />
                          </Show>
                        </Tabs.Content>
                      )}
                    </For>

                    <Tabs.Content value="empty" class="flex flex-col h-full overflow-hidden contain-strict">
                      <Show when={activeTab() === "empty"}>
                        <div class="relative pt-2 flex-1 min-h-0 overflow-hidden">
                          <div class="h-full px-6 pb-42 -mt-4 flex flex-col items-center justify-center text-center gap-6">
                            <Mark class="w-14 opacity-10" />
                            <div class="text-14-regular text-text-weak max-w-56">
                              {language.t("session.files.selectToOpen")}
                            </div>
                          </div>
                        </div>
                      </Show>
                    </Tabs.Content>

                    <Show when={contextOpen()}>
                      <Tabs.Content value="context" class="flex flex-col h-full overflow-hidden contain-strict">
                        <Show when={activeTab() === "context"}>
                          <div class="relative pt-2 flex-1 min-h-0 overflow-hidden">
                            <SessionContextTab />
                          </div>
                        </Show>
                      </Tabs.Content>
                    </Show>

                    <Show when={activeFileTab()} keyed>
                      {(tab) => <FileTabContent tab={tab} />}
                    </Show>
                  </Tabs>
                  <DragOverlay>
                    <Show when={store.activeDraggable} keyed>
                      {(tab) => {
                        const path = file.pathFromTab(tab)
                        return (
                          <div data-component="tabs-drag-preview">
                            <Show when={path}>{(p) => <FileVisual active path={p()} />}</Show>
                          </div>
                        )
                      }}
                    </Show>
                  </DragOverlay>
                </DragDropProvider>
              </div>
            </div>

            <Show when={shown()}>
              <div
                id="file-tree-panel"
                aria-hidden={!fileOpen()}
                inert={!fileOpen()}
                class="relative min-w-0 h-full shrink-0 overflow-hidden"
                classList={{
                  "pointer-events-none": !fileOpen(),
                  // Only animate width for the in-review sub-column reveal; when the
                  // file tree is the whole panel, the outer transform slide handles it.
                  "transition-[width] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] will-change-[width] motion-reduce:transition-none":
                    !props.size.active() && reviewOpen(),
                }}
                style={{ width: treeWidth() }}
              >
                <div
                  class="h-full flex flex-col overflow-hidden group/filetree"
                  classList={{ "border-l border-border-weaker-base": reviewOpen() }}
                >
                  <Tabs
                    variant="pill"
                    value={fileTreeTab()}
                    onChange={setFileTreeTabValue}
                    class="h-full"
                    data-scope="filetree"
                  >
                    <Tabs.List>
                      <Tabs.Trigger value="changes" class="flex-1" classes={{ button: "w-full" }}>
                        {props.reviewCount()}{" "}
                        {language.t(
                          props.reviewCount() === 1 ? "session.review.change.one" : "session.review.change.other",
                        )}
                      </Tabs.Trigger>
                      <Tabs.Trigger value="all" class="flex-1" classes={{ button: "w-full" }}>
                        {language.t("session.files.all")}
                      </Tabs.Trigger>
                    </Tabs.List>
                    <Tabs.Content value="changes" class="bg-background-stronger px-3 py-0">
                      <Switch>
                        <Match when={props.hasReview() || !props.diffsReady()}>
                          <Show
                            when={props.diffsReady()}
                            fallback={
                              <div class="px-2 py-2 text-12-regular text-text-weak">
                                {language.t("common.loading")}
                                {language.t("common.loading.ellipsis")}
                              </div>
                            }
                          >
                            <FileTree
                              path=""
                              class="pt-3"
                              allowed={diffFiles()}
                              kinds={kinds()}
                              draggable={false}
                              active={props.activeDiff}
                              onFileClick={(node) => props.focusReviewDiff(node.path)}
                            />
                          </Show>
                        </Match>
                      </Switch>
                    </Tabs.Content>
                    <Tabs.Content value="all" class="bg-background-stronger px-3 py-0">
                      <Switch>
                        <Match when={nofiles()}>{empty(language.t("session.files.empty"))}</Match>
                        <Match when={true}>
                          <FileTree
                            path=""
                            class="pt-3"
                            modified={diffFiles()}
                            kinds={kinds()}
                            onFileClick={(node) => openTab(file.tab(node.path))}
                          />
                        </Match>
                      </Switch>
                    </Tabs.Content>
                  </Tabs>
                </div>
                <Show when={fileOpen()}>
                  <div onPointerDown={() => props.size.start()}>
                    <ResizeHandle
                      direction="horizontal"
                      edge="start"
                      size={layout.fileTree.width()}
                      min={200}
                      max={480}
                      onResize={(width) => {
                        props.size.touch()
                        layout.fileTree.resize(width)
                      }}
                    />
                  </div>
                </Show>
              </div>
            </Show>
          </div>
        </Show>
      </aside>
    </Show>
  )
}

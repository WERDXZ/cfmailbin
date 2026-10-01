import { useI18n } from "./i18n.tsx";
import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";

export type BooleanTree<Leaf extends object> =
  | (Leaf & { all?: never; any?: never; not?: never })
  | { all: BooleanTree<Leaf>[]; any?: never; not?: never }
  | { any: BooleanTree<Leaf>[]; all?: never; not?: never }
  | { not: BooleanTree<Leaf>; all?: never; any?: never };

function size<Leaf extends object>(tree: BooleanTree<Leaf>): number {
  if (tree.not) return 1 + size(tree.not);
  return 1 +
    (tree.all ?? tree.any ?? []).reduce((sum, child) => sum + size(child), 0);
}

function height<Leaf extends object>(tree: BooleanTree<Leaf>): number {
  if (tree.not) return 1 + height(tree.not);
  return 1 + Math.max(0, ...(tree.all ?? tree.any ?? []).map(height));
}

function isLeaf<Leaf extends object>(
  tree: BooleanTree<Leaf>,
): tree is Leaf & { all?: never; any?: never; not?: never } {
  return !tree.all && !tree.any && !tree.not;
}

interface TreeProps<Leaf extends object> {
  tree: BooleanTree<Leaf>;
  change: (tree: BooleanTree<Leaf>) => void;
  createLeaf: (() => Leaf) | null;
  renderLeaf: (
    leaf: Leaf,
    change: (leaf: Leaf) => void,
    path: string,
  ) => ComponentChildren;
  maxDepth: number;
  maxNodes: number;
  maxChildren?: number;
  variant?: "rule" | "graph";
  noun?: "condition" | "policy";
  fold?: boolean;
  incomplete?: (tree: BooleanTree<Leaf>) => boolean;
}

/** Shared boolean structure; each editor owns its leaf fields and validation. */
export function BooleanTreeEditor<Leaf extends object>(props: TreeProps<Leaf>) {
  const { t } = useI18n();
  return (
    <TreeNode
      {...props}
      depth={1}
      path={props.noun === "policy" ? "Policy" : t("conditions.condition")}
      remaining={props.maxNodes - size(props.tree)}
    />
  );
}

function TreeNode<Leaf extends object>(
  props: TreeProps<Leaf> & {
    depth: number;
    path: string;
    remaining: number;
    remove?: () => void;
  },
) {
  const { t } = useI18n();
  const {
    tree,
    change,
    createLeaf,
    renderLeaf,
    maxDepth,
    maxChildren = 32,
    variant = "graph",
    noun = "condition",
    fold = true,
    incomplete,
    depth,
    path,
    remaining,
    remove,
  } = props;
  const negated = !!tree.not;
  const node = tree.not ?? tree;
  const children = node.all ?? node.any;
  const mode = node.all ? "all" : "any";
  const actualDepth = depth + Number(negated);
  const update = (next: BooleanTree<Leaf>) =>
    change(negated ? { not: next } : next);
  const updateChildren = (next: BooleanTree<Leaf>[]) =>
    update(mode === "all" ? { all: next } : { any: next });
  const foldable = fold && !!children &&
    (depth > 1 || variant === "rule" && children.length > 3);
  const [expanded, setExpanded] = useState(!foldable || !!incomplete?.(tree));
  const full = (children?.length ?? 0) >= maxChildren;
  const editor = (
    <div
      class={variant === "rule"
        ? `condition-editor condition-${children ? "group" : "leaf"}`
        : `graph-condition policy-expression ${
          depth > 1 ? "graph-condition-child" : ""
        }`}
    >
      <div class={variant === "rule" ? "condition-controls" : "graph-actions"}>
        {children && (
          <select
            aria-label={variant === "rule"
              ? t("conditions.operator", { noun: path })
              : noun === "policy"
              ? t("conditions.policyGroup")
              : t("conditions.conditionGroup")}
            value={mode}
            onChange={(event) =>
              update(
                event.currentTarget.value === "all"
                  ? { all: children }
                  : { any: children },
              )}
          >
            <option value="all">{t("conditions.allAnd")}</option>
            <option value="any">{t("conditions.anyOr")}</option>
          </select>
        )}
        <label class={variant === "rule" ? "checkbox-label" : "graph-toggle"}>
          <input
            type="checkbox"
            checked={negated}
            disabled={!negated &&
              (remaining < 1 || depth + height(node) > maxDepth)}
            onChange={(event) =>
              change(event.currentTarget.checked ? { not: node } : node)}
          />
          {t("conditions.negateNot")}
        </label>
        {remove && (
          <button
            type="button"
            class="text-button"
            aria-label={t("conditions.delete", { noun: path })}
            onClick={remove}
          >
            {t("common.delete")}
          </button>
        )}
      </div>
      {children
        ? (
          <>
            <div
              class={variant === "rule"
                ? "condition-children"
                : "graph-condition"}
            >
              {children.map((child, index) => (
                <TreeNode
                  {...props}
                  key={index}
                  tree={child}
                  depth={actualDepth + 1}
                  path={`${path} ${index + 1}`}
                  change={(next) =>
                    updateChildren(
                      children.map((value, i) => i === index ? next : value),
                    )}
                  remove={children.length > 1
                    ? () =>
                      updateChildren(children.filter((_, i) => i !== index))
                    : undefined}
                />
              ))}
            </div>
            <div class={variant === "rule" ? "button-row" : "graph-actions"}>
              <button
                type="button"
                class="text-button"
                disabled={!createLeaf || full || remaining < 1 ||
                  actualDepth >= maxDepth}
                onClick={() =>
                  createLeaf && updateChildren([...children, createLeaf()])}
              >
                {noun === "policy"
                  ? t("conditions.addPolicy")
                  : t("conditions.addCondition")}
              </button>
              <button
                type="button"
                class="text-button"
                disabled={!createLeaf || full || remaining < 2 ||
                  actualDepth >= maxDepth - 1}
                onClick={() => createLeaf &&
                  updateChildren([...children, { any: [createLeaf()] }])}
              >
                {noun === "policy"
                  ? t("conditions.addGroup")
                  : t("conditions.addConditionGroup")}
              </button>
            </div>
          </>
        )
        : node.not
        ? (
          <TreeNode
            {...props}
            tree={node}
            depth={actualDepth}
            change={update}
            remove={undefined}
          />
        )
        : isLeaf(node)
        ? (
          <>
            {renderLeaf(node, update, path)}
            <button
              type="button"
              class="text-button"
              disabled={remaining < 1 || actualDepth >= maxDepth}
              onClick={() => update({ all: [node] })}
            >
              {t("conditions.combineMore", {
                noun: noun === "policy" ? "Policy" : t("conditions.condition"),
              })}
            </button>
          </>
        )
        : null}
    </div>
  );
  return foldable
    ? (
      <details
        class={variant === "rule" ? "condition-fold" : "graph-condition-fold"}
        open={expanded}
        onToggle={(event) => setExpanded(event.currentTarget.open)}
      >
        <summary>
          {negated ? t("conditions.negate") : ""}
          {mode === "all" ? t("conditions.all") : t("conditions.any")} ·{" "}
          {t("conditions.itemCount", {
            count: children?.length ?? 0,
            noun: noun,
          })}
        </summary>
        {editor}
      </details>
    )
    : editor;
}

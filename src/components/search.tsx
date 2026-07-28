/*
 * Copyright (C) 2026 cockpit-samba contributors
 * SPDX-License-Identifier: MIT
 */

/* The search box above a table, the filtering behind it, and the state
 * shown when nothing matches. The shares table and the users table both
 * filter, and this keeps the two identical: same trimming and case
 * handling, same "no match" panel, same way back out of a filter.
 */

import React, { useState } from "react";

import cockpit from "cockpit";
import { EmptyStatePanel } from "cockpit-components-empty-state";

import { SearchInput } from "@patternfly/react-core/dist/esm/components/SearchInput/index.js";
import { SearchIcon } from "@patternfly/react-icons";

const _ = cockpit.gettext;

/* An empty needle matches everything, so the match function only ever
   sees a real, lowercased search term. */
export function useSearch<T>(items: T[], match: (item: T, needle: string) => boolean): {
    filter: string;
    setFilter: (value: string) => void;
    needle: string;
    filtered: T[];
} {
    const [filter, setFilter] = useState("");
    const needle = filter.trim().toLowerCase();
    return {
        filter,
        setFilter,
        needle,
        filtered: needle ? items.filter(item => match(item, needle)) : items,
    };
}

export const FilterInput = ({ id, placeholder, filter, setFilter }: {
    id: string;
    placeholder: string;
    filter: string;
    setFilter: (value: string) => void;
}) => (
    <SearchInput id={id}
                 placeholder={placeholder}
                 value={filter}
                 onChange={(_event, value) => setFilter(value)}
                 onClear={() => setFilter("")} />
);

export const NoMatchState = ({ title, onClear }: {
    title: string;
    onClear: () => void;
}) => (
    <EmptyStatePanel title={title}
                     icon={SearchIcon}
                     action={_("Clear filter")}
                     actionVariant="link"
                     onAction={onClear} />
);

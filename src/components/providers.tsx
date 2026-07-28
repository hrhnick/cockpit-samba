/*
 * Copyright (C) 2026 cockpit-samba contributors
 * SPDX-License-Identifier: MIT
 */

import React from "react";

import { WithDialogs } from "dialogs";

import { WithAlerts } from "./alerts";

/* The contexts the page runs in.
 *
 * The order matters and is easy to get backwards: Dialogs.show() renders
 * a dialog as a child of WithDialogs, not at the place it was called
 * from, so a dialog can only reach contexts that enclose WithDialogs
 * itself. With these two swapped, every dialog that raises an alert
 * throws the moment it opens while the rest of the page looks fine.
 *
 * This lives in one place so that the dialog tests mount dialogs in the
 * same nesting the application uses, rather than in a copy of it that
 * can drift.
 */
export const Providers = ({ children }: { children: React.ReactNode }) => (
    <WithAlerts>
        <WithDialogs>
            {children}
        </WithDialogs>
    </WithAlerts>
);

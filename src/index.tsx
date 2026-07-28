/*
 * Copyright (C) 2026 cockpit-samba contributors
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import "./app.scss";
import "polyfills";
import "cockpit-dark-theme";

import React from "react";
import { createRoot } from "react-dom/client";

import { superuser } from "superuser";

import { Application } from "./app";
import { Providers } from "./components/providers";

/* Gaining or losing administrative access changes what the whole page may
   do, so start over rather than trying to reconcile it in place. */
superuser.reload_page_on_change();

document.addEventListener("DOMContentLoaded", () => {
    const container = document.getElementById("page");
    if (!container)
        return;

    createRoot(container).render(
        <Providers>
            <Application />
        </Providers>);

    document.body.removeAttribute("hidden");
});

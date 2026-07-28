/*
 * Copyright (C) 2026 cockpit-samba contributors
 * SPDX-License-Identifier: MIT
 */

import React, { createContext, useCallback, useContext, useRef, useState } from "react";

import {
    Alert, AlertActionCloseButton, AlertGroup,
} from "@patternfly/react-core/dist/esm/components/Alert/index.js";

export type AlertVariant = "success" | "danger" | "warning" | "info";

export interface AlertRequest {
    variant: AlertVariant;
    title: string;
    detail?: string;
}

interface AlertRecord extends AlertRequest {
    key: number;
}

type AddAlert = (alert: AlertRequest) => void;

const AlertsContext = createContext<AddAlert | null>(null);

/* Report the outcome of something the user started from outside a
   dialog, such as a table row action. Failures inside a dialog belong in
   that dialog's own ModalError instead. */
export function useAlerts(): AddAlert {
    const add = useContext(AlertsContext);
    if (!add)
        throw new Error("useAlerts can only be called inside of <WithAlerts/>");
    return add;
}

export const WithAlerts = ({ children }: { children: React.ReactNode }) => {
    const [alerts, setAlerts] = useState<AlertRecord[]>([]);
    /* Date.now() collides when two alerts are raised in the same
       millisecond, which would give them the same React key. */
    const nextKey = useRef(0);

    const add = useCallback((alert: AlertRequest) => {
        const key = nextKey.current++;
        setAlerts(current => [...current, { ...alert, key }]);

        /* Successes are transient; anything the user may need to read
           twice, or copy out of, stays until dismissed. */
        if (alert.variant === "success")
            window.setTimeout(() => setAlerts(current => current.filter(a => a.key !== key)), 8000);
    }, []);

    const remove = (key: number) => setAlerts(current => current.filter(a => a.key !== key));

    return (
        <AlertsContext.Provider value={add}>
            {children}
            <AlertGroup isToast isLiveRegion>
                {alerts.map(alert => (
                    <Alert key={alert.key}
                           variant={alert.variant}
                           title={alert.title}
                           actionClose={<AlertActionCloseButton onClose={() => remove(alert.key)} />}>
                        {alert.detail}
                    </Alert>
                ))}
            </AlertGroup>
        </AlertsContext.Provider>
    );
};

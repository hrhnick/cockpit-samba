/*
 * Copyright (C) 2026 cockpit-samba contributors
 * SPDX-License-Identifier: MIT
 */

/* The two rows of chips this page shows in table cells and description
   lists. Both live here so that the spacing stays the one Cockpit's own
   tables use: it took a measurement session to establish that 8px is
   what the Accounts page gives a label row, and three separate copies
   would drift apart the first time anyone adjusted one. */

import React from "react";

import { Label } from "@patternfly/react-core/dist/esm/components/Label/index.js";
import { Flex } from "@patternfly/react-core/dist/esm/layouts/Flex/index.js";

const Row = ({ children }: { children: React.ReactNode }) => (
    <Flex spaceItems={{ default: "spaceItemsSm" }}>{children}</Flex>
);

/* Users and groups, coloured as the Accounts page colours them: groups
   yellow, accounts blue. smb.conf marks a group with a leading @. */
export const PrincipalLabels = ({ principals }: { principals: string[] }) => (
    <Row>
        {principals.map(name => (
            <Label key={name} color={name.startsWith("@") ? "yellow" : "blue"} isCompact>
                {name}
            </Label>
        ))}
    </Row>
);

/* Share names, which carry no meaning worth colouring. */
export const ShareLabels = ({ shares }: { shares: string[] }) => (
    <Row>
        {shares.map(share => <Label key={share} isCompact>{share}</Label>)}
    </Row>
);

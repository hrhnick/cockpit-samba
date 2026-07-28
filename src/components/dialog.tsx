/*
 * Copyright (C) 2026 cockpit-samba contributors
 * SPDX-License-Identifier: MIT
 */

import React, { useState } from "react";

import cockpit from "cockpit";
import { useDialogs } from "dialogs";
import { ModalError } from "cockpit-components-inline-notification";

import { Button, type ButtonProps } from "@patternfly/react-core/dist/esm/components/Button/index.js";
import { Form } from "@patternfly/react-core/dist/esm/components/Form/index.js";
import {
    Modal, ModalBody, ModalFooter, ModalHeader,
} from "@patternfly/react-core/dist/esm/components/Modal/index.js";
import type { ModalProps } from "@patternfly/react-core/dist/esm/components/Modal/index.js";
import type { ModalHeaderProps } from "@patternfly/react-core/dist/esm/components/Modal/ModalHeader";

import { errorString } from "../samba/client";

const _ = cockpit.gettext;

export interface DialogFrameProps {
    title: string;
    titleIconVariant?: ModalHeaderProps["titleIconVariant"];
    description?: React.ReactNode;
    variant?: ModalProps["variant"];
    id?: string;
    /* The primary action. Rejecting shows the reason in the dialog and
       leaves it open; resolving closes it. */
    onApply: () => Promise<void>;
    actionLabel: string;
    actionVariant?: ButtonProps["variant"];
    isActionDisabled?: boolean;
    /* Where dismissing and a successful apply land. By default both
       close the dialog; a dialog that is really a view inside another
       one (Manage access) goes back to that view instead, usually with
       cancelLabel "Back". */
    onClose?: () => void;
    cancelLabel?: string;
    /* Extra footer buttons, placed before the primary action. */
    secondaryActions?: React.ReactNode;
    /* Wrap the body in a <Form>, so that pressing Enter in a field
       triggers the primary action. */
    isForm?: boolean;
    isHorizontal?: boolean;
    children?: React.ReactNode;
}

/* The shape every dialog on this page shares: a header, a body that can
 * show an error from the last attempt, and a footer with one primary
 * action and Cancel. Keeping it in one place is what lets the individual
 * dialogs be just their fields and their apply function.
 */
export const DialogFrame = ({
    title, titleIconVariant, description, variant = "medium", id,
    onApply, actionLabel, actionVariant = "primary", isActionDisabled = false,
    onClose, cancelLabel,
    secondaryActions, isForm = false, isHorizontal = false, children,
}: DialogFrameProps) => {
    const Dialogs = useDialogs();
    const [error, setError] = useState<string | null>(null);
    const [applying, setApplying] = useState(false);

    const close = onClose ?? (() => Dialogs.close());

    async function apply() {
        setApplying(true);
        setError(null);
        try {
            await onApply();
            /* Closing (or switching back to the enclosing view) unmounts
               this component, so no state is touched after a successful
               apply. */
            close();
        } catch (exception) {
            setError(errorString(exception));
            setApplying(false);
        }
    }

    const body = (
        <>
            {error && <ModalError dialogError={error} />}
            {children}
        </>
    );

    return (
        <Modal id={id} isOpen position="top" variant={variant} onClose={close}>
            <ModalHeader title={title} description={description}
                {...titleIconVariant && { titleIconVariant }} />
            <ModalBody>
                {isForm
                    ? (
                        <Form isHorizontal={isHorizontal}
                              onSubmit={event => { event.preventDefault(); if (!isActionDisabled) apply(); }}>
                            {body}
                        </Form>
                    )
                    : body}
            </ModalBody>
            <ModalFooter>
                {secondaryActions}
                <Button variant={actionVariant}
                        isLoading={applying}
                        isDisabled={applying || isActionDisabled}
                        onClick={apply}>
                    {actionLabel}
                </Button>
                <Button variant="link" isDisabled={applying} onClick={close}>
                    {cancelLabel ?? _("Cancel")}
                </Button>
            </ModalFooter>
        </Modal>
    );
};

/* A destructive action the user has to confirm, e.g. deleting a share.
   The body explains what will and will not happen. */
export const ConfirmDialog = ({ title, actionLabel, onApply, children }: {
    title: string;
    actionLabel: string;
    onApply: () => Promise<void>;
    children: React.ReactNode;
}) => (
    <DialogFrame title={title}
                 titleIconVariant="warning"
                 variant="small"
                 actionLabel={actionLabel}
                 actionVariant="danger"
                 onApply={onApply}>
        {children}
    </DialogFrame>
);

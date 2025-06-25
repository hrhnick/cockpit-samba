// Optimized Cockpit Samba Plugin JavaScript
(function() {
    'use strict';

    // Utility Classes
    class CommandExecutor {
        static async execute(command, options = {}) {
            try {
                const result = await cockpit.spawn(command, options);
                return { success: true, data: result };
            } catch (error) {
                const errorMsg = error.message || error.toString();
                console.error('Command failed:', command, errorMsg);
                return { success: false, error: errorMsg };
            }
        }
    }

    class ModalManager {
        constructor(modalId, app) {
            this.modal = document.getElementById(modalId);
            this.app = app;
            this.isVisible = false;
            this.mode = 'add';
            this.formFields = {};
            this.cacheFormFields();
        }

        cacheFormFields() {
            const fields = ['share-name', 'share-path', 'share-comment', 'share-users', 'share-readonly', 'share-guest', 'share-browseable'];
            fields.forEach(id => {
                this.formFields[id] = document.getElementById(id);
            });
        }

        show(mode = 'add', data = null) {
            this.mode = mode;
            this.updateModalForMode(mode, data);
            this.modal.style.display = 'flex';
            this.isVisible = true;
            this.focusFirstInput();
        }

        hide() {
            this.modal.style.display = 'none';
            this.isVisible = false;
            this.clearForm();
            
            // Re-enable submit button when hiding modal
            const submitBtn = document.getElementById('submit-share-btn');
            if (submitBtn) {
                submitBtn.disabled = false;
                if (this.mode === 'edit') {
                    submitBtn.textContent = 'Update share';
                } else {
                    submitBtn.textContent = 'Create share';
                }
            }
        }

        updateModalForMode(mode, data) {
            const isEdit = mode === 'edit';
            this.modal.querySelector('h3').textContent = isEdit ? 'Edit share' : 'Add new share';
            this.modal.querySelector('#submit-share-btn').textContent = isEdit ? 'Update share' : 'Create share';
            
            if (isEdit && data) {
                this.populateForm(data);
            }
        }

        populateForm(data) {
            // Add hidden field for original name if editing
            let originalNameField = document.getElementById('edit-original-name');
            if (!originalNameField) {
                originalNameField = document.createElement('input');
                originalNameField.type = 'hidden';
                originalNameField.id = 'edit-original-name';
                document.getElementById('add-share-form').appendChild(originalNameField);
            }
            
            originalNameField.value = data.name;
            this.formFields['share-name'].value = data.name;
            this.formFields['share-path'].value = data.path;
            this.formFields['share-comment'].value = data.comment || '';
            this.formFields['share-readonly'].checked = data.readonly;
            this.formFields['share-guest'].checked = data.guest;
            this.formFields['share-browseable'].checked = data.browseable;
            this.formFields['share-users'].value = data.validUsers || '';
        }

        clearForm() {
            this.formFields['share-name'].value = '';
            this.formFields['share-path'].value = '';
            this.formFields['share-comment'].value = '';
            this.formFields['share-readonly'].checked = false;
            this.formFields['share-guest'].checked = false;
            this.formFields['share-browseable'].checked = true;
            this.formFields['share-users'].value = '';
            
            const originalNameField = document.getElementById('edit-original-name');
            if (originalNameField) {
                originalNameField.value = '';
            }
        }

        focusFirstInput() {
            const firstInput = this.formFields['share-name'];
            if (firstInput) {
                firstInput.focus();
                if (this.mode === 'edit') {
                    firstInput.select();
                }
            }
        }

        getFormData() {
            return {
                originalName: document.getElementById('edit-original-name')?.value || '',
                name: this.formFields['share-name'].value.trim(),
                path: this.formFields['share-path'].value.trim(),
                comment: this.formFields['share-comment'].value.trim(),
                readonly: this.formFields['share-readonly'].checked,
                guest: this.formFields['share-guest'].checked,
                browseable: this.formFields['share-browseable'].checked,
                users: this.formFields['share-users'].value.trim()
            };
        }
    }

    class ShareConfigManager {
        static createDefaultShare(name) {
            return {
                name: name,
                path: '',
                comment: '',
                readonly: false,
                guest: false,
                browseable: true,
                validUsers: ''
            };
        }

        static parseShareProperty(share, line) {
            const equalIndex = line.indexOf('=');
            const key = line.substring(0, equalIndex).trim().toLowerCase();
            const value = line.substring(equalIndex + 1).trim();
            
            switch (key) {
                case 'path':
                    share.path = value;
                    break;
                case 'comment':
                    share.comment = value;
                    break;
                case 'read only':
                case 'readonly':
                    share.readonly = value.toLowerCase() === 'yes' || value.toLowerCase() === 'true';
                    break;
                case 'guest ok':
                case 'public':
                    share.guest = value.toLowerCase() === 'yes' || value.toLowerCase() === 'true';
                    break;
                case 'browseable':
                case 'browsable':
                    share.browseable = value.toLowerCase() !== 'no' && value.toLowerCase() !== 'false';
                    break;
                case 'valid users':
                    share.validUsers = value;
                    break;
            }
        }

        static parseShareConfig(configContent, targetShare = null) {
            const shares = [];
            const lines = configContent.split('\n');
            let currentShare = null;
            
            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(';')) continue;
                
                if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
                    if (currentShare && currentShare.name !== 'global') {
                        if (targetShare && currentShare.name === targetShare) {
                            return currentShare;
                        }
                        shares.push(currentShare);
                    }
                    
                    const sectionName = trimmed.slice(1, -1);
                    if (sectionName !== 'global') {
                        currentShare = this.createDefaultShare(sectionName);
                    } else {
                        currentShare = null;
                    }
                } else if (currentShare && trimmed.includes('=')) {
                    this.parseShareProperty(currentShare, trimmed);
                }
            }
            
            if (currentShare && currentShare.name !== 'global') {
                if (targetShare && currentShare.name === targetShare) {
                    return currentShare;
                }
                shares.push(currentShare);
            }
            
            return targetShare ? null : shares;
        }

        static generateShareConfig(shareData) {
            let config = `\n[${shareData.name}]\n`;
            config += `    path = ${shareData.path}\n`;
            if (shareData.comment) config += `    comment = ${shareData.comment}\n`;
            config += `    read only = ${shareData.readonly ? 'yes' : 'no'}\n`;
            config += `    guest ok = ${shareData.guest ? 'yes' : 'no'}\n`;
            config += `    browseable = ${shareData.browseable ? 'yes' : 'no'}\n`;
            if (shareData.users) config += `    valid users = ${shareData.users}\n`;
            return config;
        }
    }

    // Global functions for backward compatibility
    window.disableSambaGlobal = async function(username) {
        if (!username || !window.sambaApp) return;
        
        const result = await CommandExecutor.execute(['smbpasswd', '-x', username], { superuser: 'require' });
        
        if (result.success) {
            await window.sambaApp.loadUsers();
            window.sambaApp.showNotification(`Samba access disabled for user "${username}"`, 'success');
        } else {
            window.sambaApp.showNotification('Failed to disable Samba user: ' + result.error, 'error');
        }
    };

    window.createShareGlobal = async function() {
        if (!window.sambaApp || window.sambaApp.isSubmitting) return;
        window.sambaApp.isSubmitting = true;
        
        try {
            const formData = window.sambaApp.shareModal.getFormData();
            await window.sambaApp.createShare(formData);
        } finally {
            setTimeout(() => {
                if (window.sambaApp) {
                    window.sambaApp.isSubmitting = false;
                }
            }, 1000);
        }
    };

    window.editShareGlobal = async function(shareName) {
        if (!window.sambaApp) return;
        await window.sambaApp.editShare(shareName);
    };

    window.saveEditedShareGlobal = async function() {
        if (!window.sambaApp || window.sambaApp.isSubmitting) return;
        window.sambaApp.isSubmitting = true;
        
        try {
            const formData = window.sambaApp.shareModal.getFormData();
            await window.sambaApp.updateShare(formData);
        } finally {
            setTimeout(() => {
                if (window.sambaApp) {
                    window.sambaApp.isSubmitting = false;
                }
            }, 1000);
        }
    };

    window.deleteShareGlobal = async function(shareName) {
        if (!window.sambaApp) return;
        await window.sambaApp.deleteShare(shareName);
    };

    // Main Application Class
    class SambaApp {
        constructor() {
            this.shares = [];
            this.users = [];
            this.currentTab = 'shares';
            this.sambaInstalled = false;
            this.sambaService = null;
            this.sortColumn = null;
            this.sortDirection = 'asc';
            this.domCache = new Map();
            this.shareModal = null;
            this.debounceTimers = new Map();
            this.isSubmitting = false; // Prevent duplicate submissions
            this.buttonCooldowns = new Map(); // Prevent rapid button clicks
        }

        // Helper method to prevent rapid button clicks
        isButtonOnCooldown(buttonId, cooldownMs = 500) {
            const now = Date.now();
            const lastClick = this.buttonCooldowns.get(buttonId) || 0;
            
            if (now - lastClick < cooldownMs) {
                return true; // Still on cooldown
            }
            
            this.buttonCooldowns.set(buttonId, now);
            return false;
        }

        getElement(id) {
            if (!this.domCache.has(id)) {
                const element = document.getElementById(id);
                if (element) {
                    this.domCache.set(id, element);
                } else {
                    console.warn(`Element with id '${id}' not found`);
                    return null;
                }
            }
            return this.domCache.get(id);
        }

        debounce(key, func, delay = 300) {
            if (this.debounceTimers.has(key)) {
                clearTimeout(this.debounceTimers.get(key));
            }
            
            const timer = setTimeout(func, delay);
            this.debounceTimers.set(key, timer);
        }

        async init() {
            await this.hideLoading();
            
            const sambaDetection = await this.detectSambaService();
            this.sambaInstalled = sambaDetection.installed;
            this.sambaService = sambaDetection.serviceName;
            
            if (this.sambaInstalled) {
                this.shareModal = new ModalManager('add-share-modal', this);
                this.setupEventListeners();
                this.showServiceStatus();
                await this.loadData();
                this.showMainContent();
            }
        }

        async hideLoading() {
            await new Promise(resolve => setTimeout(resolve, 500));
            const loadingOverlay = this.getElement('loading-overlay');
            if (loadingOverlay) {
                loadingOverlay.style.display = 'none';
            }
        }

        async detectSambaService() {
            const detectionMethods = [
                { method: () => CommandExecutor.execute(['which', 'smbd']), type: 'binary' },
                { method: () => CommandExecutor.execute(['systemctl', 'status', 'smb']), type: 'service', name: 'smb' },
                { method: () => CommandExecutor.execute(['systemctl', 'status', 'smbd']), type: 'service', name: 'smbd' },
                { method: () => CommandExecutor.execute(['rpm', '-q', 'samba']), type: 'package' },
                { method: () => CommandExecutor.execute(['dpkg', '-l', 'samba']), type: 'package' }
            ];
            
            for (const { method, type, name } of detectionMethods) {
                const result = await method();
                if (result.success) {
                    return { installed: true, serviceName: name || 'smbd', type };
                }
            }
            
            // Check for running processes
            const processCheck = await CommandExecutor.execute(['pgrep', '-f', 'smbd']);
            if (processCheck.success && processCheck.data.trim()) {
                return { installed: true, serviceName: 'smbd (process)', type: 'process' };
            }
            
            this.showInstallationRequired();
            return { installed: false };
        }

        showInstallationRequired() {
            this.getElement('samba-not-installed').style.display = 'block';
            this.getElement('main-content').style.display = 'none';
            this.getElement('service-status-section').style.display = 'none';
        }

        showServiceStatus() {
            this.getElement('service-status-section').style.display = 'block';
            this.loadServiceStatus();
        }

        showMainContent() {
            this.getElement('samba-not-installed').style.display = 'none';
            this.getElement('main-content').style.display = 'block';
        }

        async loadServiceStatus() {
            let serviceStatus = 'unknown';
            let isRunning = false;
            
            // First check if any samba processes are running
            const processCheck = await CommandExecutor.execute(['pgrep', '-f', 'smbd']);
            if (processCheck.success && processCheck.data.trim()) {
                isRunning = true;
                serviceStatus = 'active';
            }
            
            // If no processes found, check systemd services
            if (!isRunning && this.sambaService && this.sambaService !== 'smbd (process)') {
                const systemdCheck = await CommandExecutor.execute(['systemctl', 'is-active', this.sambaService]);
                if (systemdCheck.success) {
                    const status = systemdCheck.data.trim();
                    serviceStatus = status;
                    isRunning = (status === 'active');
                }
            }
            
            // Double-check with alternative service names if still unknown
            if (serviceStatus === 'unknown') {
                const servicesToCheck = ['smb', 'smbd', 'samba'];
                for (const service of servicesToCheck) {
                    const result = await CommandExecutor.execute(['systemctl', 'is-active', service]);
                    if (result.success) {
                        const status = result.data.trim();
                        if (status === 'active') {
                            serviceStatus = 'active';
                            isRunning = true;
                            this.sambaService = service;
                            break;
                        } else if (status === 'inactive') {
                            serviceStatus = 'inactive';
                            this.sambaService = service;
                        }
                    }
                }
                
                // If still unknown, check one more time with netstat for port 445
                if (serviceStatus === 'unknown') {
                    const portCheck = await CommandExecutor.execute(['netstat', '-tuln']);
                    if (portCheck.success && portCheck.data.includes(':445 ')) {
                        serviceStatus = 'active';
                        isRunning = true;
                    } else {
                        serviceStatus = 'inactive';
                    }
                }
            }
            
            this.updateServiceStatus(serviceStatus, this.sambaService || 'smb/smbd');
        }

        updateServiceStatus(status, serviceName = 'smb/smbd') {
            const statusBadge = this.getElement('service-status-badge');
            const startBtn = this.getElement('start-service-btn');
            const stopBtn = this.getElement('stop-service-btn');
            const serviceNameElement = document.querySelector('.service-name');

            statusBadge.className = `status-badge status-${status}`;
            if (serviceNameElement) {
                serviceNameElement.textContent = `Samba (${serviceName})`;
            }

            switch (status) {
                case 'active':
                    statusBadge.textContent = 'Running';
                    startBtn.textContent = 'Restart';
                    startBtn.className = 'pf-v6-c-button pf-v6-c-button--warning';
                    startBtn.disabled = false;
                    startBtn.setAttribute('aria-label', 'Restart Samba service');
                    stopBtn.disabled = false;
                    break;
                case 'inactive':
                    statusBadge.textContent = 'Stopped';
                    startBtn.textContent = 'Start';
                    startBtn.className = 'pf-v6-c-button pf-v6-c-button--success';
                    startBtn.disabled = false;
                    startBtn.setAttribute('aria-label', 'Start Samba service');
                    stopBtn.disabled = true;
                    break;
                default:
                    statusBadge.textContent = 'Unknown';
                    startBtn.textContent = 'Start';
                    startBtn.className = 'pf-v6-c-button pf-v6-c-button--success';
                    startBtn.disabled = false;
                    startBtn.setAttribute('aria-label', 'Start Samba service');
                    stopBtn.disabled = false;
            }
        }

        setupEventListeners() {
            // Direct event listeners for critical buttons (not delegated)
            this.getElement('add-share-btn').addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                if (this.isButtonOnCooldown('add-share-btn', 300)) return;
                this.shareModal.show('add');
            });

            this.getElement('manage-users-btn').addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                if (this.isButtonOnCooldown('manage-users-btn', 500)) return;
                this.navigateToUsers();
            });

            this.getElement('start-service-btn').addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                if (this.isButtonOnCooldown('start-service-btn', 1000)) return;
                this.startService();
            });

            this.getElement('stop-service-btn').addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                if (this.isButtonOnCooldown('stop-service-btn', 1000)) return;
                this.stopService();
            });

            // Modal control buttons
            this.getElement('cancel-share-btn').addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                this.shareModal.hide();
            });

            this.getElement('close-share-modal').addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                this.shareModal.hide();
            });

            this.getElement('submit-share-btn').addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                if (this.isButtonOnCooldown('submit-share-btn', 500)) return;
                this.handleShareFormSubmit();
            });

            // Password modal buttons
            this.getElement('close-password-modal').addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                this.hideSambaPasswordModal();
            });

            this.getElement('set-password-btn').addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                if (this.isButtonOnCooldown('set-password-btn', 500)) return;
                this.setSambaPassword();
            });

            this.getElement('cancel-password-btn').addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                this.hideSambaPasswordModal();
            });

            // Tab switching with direct listeners
            document.querySelectorAll('.pf-v6-c-tabs__tab').forEach(tab => {
                tab.addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    const tabName = e.target.dataset.tab;
                    if (tabName && !this.isButtonOnCooldown(`tab-${tabName}`, 200)) {
                        this.switchTab(tabName);
                    }
                });
            });

            // Delegated event handling for table actions only
            document.addEventListener('click', this.handleTableActions.bind(this));
            
            // Search with debouncing
            this.getElement('shares-search').addEventListener('input', (e) => {
                this.debounce('shares-search', () => this.filterShares(e.target.value));
            });
            
            this.getElement('users-search').addEventListener('input', (e) => {
                this.debounce('users-search', () => this.filterUsers(e.target.value));
            });

            // Form submission
            this.getElement('add-share-form').addEventListener('submit', (e) => {
                e.preventDefault();
                this.handleShareFormSubmit();
            });

            this.getElement('samba-password-form').addEventListener('submit', (e) => {
                e.preventDefault();
                this.setSambaPassword();
            });

            // Modal backdrop clicks
            this.getElement('add-share-modal').addEventListener('click', (e) => {
                if (e.target === e.currentTarget) this.shareModal.hide();
            });
            
            this.getElement('samba-password-modal').addEventListener('click', (e) => {
                if (e.target === e.currentTarget) this.hideSambaPasswordModal();
            });

            // Keyboard shortcuts
            document.addEventListener('keydown', this.handleDocumentKeydown.bind(this));

            this.setupTableSorting();
        }

        // Separate handler just for table actions to avoid conflicts
        handleTableActions(e) {
            const { target } = e;
            const action = target.dataset.action;
            const targetName = target.dataset.target;
            
            if (action && targetName) {
                e.preventDefault();
                e.stopPropagation();
                this.handleTableAction(action, targetName, e);
            }
        }

        // Utility method to provide user feedback during operations
        async withButtonFeedback(buttonId, operation, loadingText = 'Processing...') {
            const button = this.getElement(buttonId);
            if (!button) return operation();
            
            const originalText = button.textContent;
            const wasDisabled = button.disabled;
            
            button.disabled = true;
            button.textContent = loadingText;
            
            try {
                const result = await operation();
                return result;
            } finally {
                button.disabled = wasDisabled;
                button.textContent = originalText;
            }
        }

        handleDocumentKeydown(e) {
            if (e.key === 'Escape') {
                if (this.shareModal.isVisible) {
                    this.shareModal.hide();
                } else if (this.getElement('samba-password-modal').style.display === 'flex') {
                    this.hideSambaPasswordModal();
                }
            }
        }

        handleTableAction(action, target, e) {
            e.preventDefault();
            
            switch (action) {
                case 'edit-share':
                    this.editShare(target);
                    break;
                case 'delete-share':
                    this.deleteShare(target);
                    break;
                case 'enable-samba':
                    this.enableSambaUser(target);
                    break;
                case 'disable-samba':
                    window.disableSambaGlobal(target);
                    break;
                case 'change-password':
                    this.showSambaPasswordModal(target);
                    break;
            }
        }

        handleShareFormSubmit() {
            // Prevent multiple submissions
            if (this.isSubmitting) {
                return;
            }
            
            this.isSubmitting = true;
            
            try {
                if (this.shareModal.mode === 'edit') {
                    const formData = this.shareModal.getFormData();
                    this.updateShare(formData);
                } else {
                    const formData = this.shareModal.getFormData();
                    this.createShare(formData);
                }
            } finally {
                // Reset the flag after a short delay to prevent rapid successive clicks
                setTimeout(() => {
                    this.isSubmitting = false;
                }, 1000);
            }
        }

        switchTab(tab) {
            // Update tab buttons - remove active from all first
            document.querySelectorAll('.pf-v6-c-tabs__tab').forEach(link => {
                link.classList.remove('active');
                link.setAttribute('aria-selected', 'false');
            });
            
            // Add active to selected tab
            const selectedTab = document.querySelector(`[data-tab="${tab}"]`);
            if (selectedTab) {
                selectedTab.classList.add('active');
                selectedTab.setAttribute('aria-selected', 'true');
            }

            // Update tab panels
            document.querySelectorAll('.tab-content').forEach(panel => {
                panel.classList.remove('active');
            });
            this.getElement(`${tab}-tab`).classList.add('active');

            this.currentTab = tab;
        }

        async loadData() {
            await Promise.all([
                this.loadShares(),
                this.loadUsers()
            ]);
        }

        async loadShares() {
            const configExists = await CommandExecutor.execute(['test', '-f', '/etc/samba/smb.conf']);
            if (!configExists.success) {
                this.shares = [];
                this.renderShares();
                return;
            }
            
            const configResult = await CommandExecutor.execute(['cat', '/etc/samba/smb.conf']);
            if (configResult.success) {
                const shares = ShareConfigManager.parseShareConfig(configResult.data);
                this.shares = shares;
            } else {
                this.shares = [];
            }
            
            this.renderShares();
        }

        renderShares() {
            const tbody = this.getElement('shares-tbody');
            
            if (this.shares.length === 0) {
                tbody.innerHTML = `
                    <tr class="empty-row">
                        <td colspan="5">No shares configured. Click "Add share" to create your first share.</td>
                    </tr>
                `;
                return;
            }

            tbody.innerHTML = this.shares.map(share => `
                <tr>
                    <td><strong>${this.escapeHtml(share.name)}</strong></td>
                    <td><code class="path-cell">${this.escapeHtml(share.path)}</code></td>
                    <td>${this.escapeHtml(share.comment || '-')}</td>
                    <td>
                        <div class="access-badges">
                            <span class="access-badge ${share.readonly ? 'read-only' : 'read-write'}">
                                ${share.readonly ? 'Read Only' : 'Read/Write'}
                            </span>
                            ${share.guest ? '<span class="access-badge guest">Guest</span>' : ''}
                        </div>
                    </td>
                    <td>
                        <button class="table-action-btn" data-action="edit-share" data-target="${this.escapeHtml(share.name)}">Edit</button>
                        <button class="table-action-btn danger" data-action="delete-share" data-target="${this.escapeHtml(share.name)}">Delete</button>
                    </td>
                </tr>
            `).join('');
        }

        async loadUsers() {
            const result = await CommandExecutor.execute(['getent', 'passwd']);
            if (result.success) {
                const users = this.parseSystemUsers(result.data);
                this.users = users;
                await this.loadSambaUsers();
            } else {
                this.users = [];
            }
            this.renderUsers();
        }

        parseSystemUsers(output) {
            const users = [];
            const lines = output.split('\n');

            for (const line of lines) {
                const parts = line.split(':');
                if (parts.length >= 5) {
                    const username = parts[0];
                    const uid = parseInt(parts[2]);
                    const fullName = parts[4].split(',')[0];
                    const shell = parts[6];

                    const isSystemUser = username.includes('-') || 
                                       username.includes('_') || 
                                       username === 'nobody' ||
                                       username.startsWith('cockpit') ||
                                       username.startsWith('systemd') ||
                                       username.startsWith('ssh') ||
                                       shell === '/sbin/nologin' ||
                                       shell === '/bin/false' ||
                                       shell === '/usr/sbin/nologin';

                    if (uid >= 1000 && uid < 65534 && !isSystemUser) {
                        users.push({
                            username: username,
                            fullName: fullName || username,
                            sambaEnabled: false
                        });
                    }
                }
            }

            return users;
        }

        async loadSambaUsers() {
            let sambaUsers = [];
            
            const pdbeditResult = await CommandExecutor.execute(['pdbedit', '-L'], { superuser: 'try' });
            if (pdbeditResult.success) {
                sambaUsers = pdbeditResult.data.split('\n')
                    .filter(line => line.trim())
                    .map(line => line.split(':')[0]);
            } else {
                // Try smbpasswd file locations
                const possiblePaths = [
                    '/var/lib/samba/private/smbpasswd',
                    '/etc/samba/smbpasswd',
                    '/usr/local/samba/private/smbpasswd'
                ];
                
                for (const path of possiblePaths) {
                    const fileResult = await CommandExecutor.execute(['cat', path], { superuser: 'try' });
                    if (fileResult.success) {
                        sambaUsers = fileResult.data.split('\n')
                            .filter(line => line.trim() && !line.startsWith('#'))
                            .map(line => line.split(':')[0]);
                        break;
                    }
                }
            }

            this.users.forEach(user => {
                user.sambaEnabled = sambaUsers.includes(user.username);
            });
        }

        renderUsers() {
            const tbody = this.getElement('users-tbody');
            
            if (this.users.length === 0) {
                tbody.innerHTML = `
                    <tr class="empty-row">
                        <td colspan="4">No regular user accounts found on this system.</td>
                    </tr>
                `;
                return;
            }

            tbody.innerHTML = this.users.map(user => `
                <tr>
                    <td><strong>${this.escapeHtml(user.username)}</strong></td>
                    <td>${this.escapeHtml(user.fullName)}</td>
                    <td>
                        <div class="user-status">
                            <span class="user-status-indicator ${user.sambaEnabled ? 'enabled' : 'disabled'}"></span>
                            <span>${user.sambaEnabled ? 'Enabled' : 'Disabled'}</span>
                        </div>
                    </td>
                    <td>
                        <div class="table-action-buttons">
                            ${user.sambaEnabled ? `
                                <button class="table-action-btn primary" data-action="change-password" data-target="${this.escapeHtml(user.username)}">Change Password</button>
                                <button class="table-action-btn danger" data-action="disable-samba" data-target="${this.escapeHtml(user.username)}">Disable Samba</button>
                            ` : `
                                <button class="table-action-btn primary" data-action="enable-samba" data-target="${this.escapeHtml(user.username)}">Enable Samba</button>
                            `}
                        </div>
                    </td>
                </tr>
            `).join('');
        }

        // Share management methods
        validateShareForm(formData) {
            const validators = [
                { test: () => formData.name, message: 'Name is required' },
                { test: () => formData.path, message: 'Path is required' },
                { test: () => /^[a-zA-Z0-9_-]+$/.test(formData.name), message: 'Share name can only contain letters, numbers, hyphens, and underscores' }
            ];
            
            for (const { test, message } of validators) {
                if (!test()) {
                    this.showNotification(message, 'error');
                    return false;
                }
            }
            
            return true;
        }

        async validateUsersAndGroups(usersString) {
            if (!usersString.trim()) {
                return { valid: true };
            }
            
            const items = usersString.split(',').map(item => item.trim()).filter(item => item);
            const invalidUsers = [];
            const invalidGroups = [];
            
            for (const item of items) {
                if (item.startsWith('@')) {
                    const groupName = item.substring(1);
                    const result = await CommandExecutor.execute(['getent', 'group', groupName]);
                    if (!result.success || !result.data.trim()) {
                        invalidGroups.push(groupName);
                    }
                } else {
                    const result = await CommandExecutor.execute(['getent', 'passwd', item]);
                    if (!result.success || !result.data.trim()) {
                        invalidUsers.push(item);
                    }
                }
            }
            
            if (invalidUsers.length > 0 || invalidGroups.length > 0) {
                let message = 'Invalid entries found:\n';
                if (invalidUsers.length > 0) {
                    message += `• Users not found: ${invalidUsers.join(', ')}\n`;
                }
                if (invalidGroups.length > 0) {
                    message += `• Groups not found: ${invalidGroups.join(', ')}`;
                }
                return { valid: false, message };
            }
            
            return { valid: true };
        }

        async createShare(formData) {
            if (!this.validateShareForm(formData)) return;

            // Disable submit button during creation
            const submitBtn = this.getElement('submit-share-btn');
            const originalText = submitBtn.textContent;
            submitBtn.disabled = true;
            submitBtn.textContent = 'Creating...';

            if (formData.users) {
                const validationResult = await this.validateUsersAndGroups(formData.users);
                if (!validationResult.valid) {
                    this.showNotification(validationResult.message, 'error');
                    submitBtn.disabled = false;
                    submitBtn.textContent = originalText;
                    return;
                }
            }

            try {
                // Check if share already exists
                const configResult = await CommandExecutor.execute(['cat', '/etc/samba/smb.conf']);
                if (configResult.success && configResult.data.includes(`[${formData.name}]`)) {
                    this.showNotification(`Share "${formData.name}" already exists`, 'error');
                    submitBtn.disabled = false;
                    submitBtn.textContent = originalText;
                    return;
                }
                
                const shareConfig = ShareConfigManager.generateShareConfig(formData);
                
                const result = await CommandExecutor.execute(['bash', '-c', `echo "${shareConfig.replace(/"/g, '\\"')}" >> /etc/samba/smb.conf`], { superuser: 'require' });
                
                if (!result.success) {
                    this.showNotification(`Failed to create share: ${result.error}`, 'error');
                    submitBtn.disabled = false;
                    submitBtn.textContent = originalText;
                    return;
                }

                await this.reloadSambaService();
                this.shareModal.hide();
                await this.loadShares();
                this.showNotification(`Share "${formData.name}" created successfully`, 'success');
                
            } catch (error) {
                console.error('Failed to create share:', error);
                this.showNotification('Failed to create share: ' + (error.message || error), 'error');
                submitBtn.disabled = false;
                submitBtn.textContent = originalText;
            }
        }

        async editShare(shareName) {
            const configResult = await CommandExecutor.execute(['cat', '/etc/samba/smb.conf']);
            if (!configResult.success) {
                this.showNotification('Failed to read configuration', 'error');
                return;
            }
            
            const shareData = ShareConfigManager.parseShareConfig(configResult.data, shareName);
            if (!shareData) {
                this.showNotification(`Share "${shareName}" not found in configuration`, 'error');
                return;
            }
            
            this.shareModal.show('edit', shareData);
        }

        async updateShare(formData) {
            if (!this.validateShareForm(formData)) return;

            // Disable submit button during update
            const submitBtn = this.getElement('submit-share-btn');
            const originalText = submitBtn.textContent;
            submitBtn.disabled = true;
            submitBtn.textContent = 'Updating...';

            if (formData.name !== formData.originalName) {
                const configResult = await CommandExecutor.execute(['cat', '/etc/samba/smb.conf']);
                if (configResult.success && configResult.data.includes(`[${formData.name}]`)) {
                    this.showNotification(`Share "${formData.name}" already exists`, 'error');
                    submitBtn.disabled = false;
                    submitBtn.textContent = originalText;
                    return;
                }
            }

            if (formData.users) {
                const validationResult = await this.validateUsersAndGroups(formData.users);
                if (!validationResult.valid) {
                    this.showNotification(validationResult.message, 'error');
                    submitBtn.disabled = false;
                    submitBtn.textContent = originalText;
                    return;
                }
            }

            try {
                // Create backup
                const backupFile = `/etc/samba/smb.conf.backup.${Date.now()}`;
                await CommandExecutor.execute(['cp', '/etc/samba/smb.conf', backupFile], { superuser: 'require' });
                
                // Delete old share section
                const sedCommand = `/^\\[${formData.originalName}\\]/,/^\\[.*\\]/{/^\\[${formData.originalName}\\]/d; /^\\[.*\\]/!d;}`;
                await CommandExecutor.execute(['sed', '-i', sedCommand, '/etc/samba/smb.conf'], { superuser: 'require' });
                
                // Add updated share configuration
                const shareConfig = ShareConfigManager.generateShareConfig(formData);
                await CommandExecutor.execute(['bash', '-c', `echo "${shareConfig.replace(/"/g, '\\"')}" >> /etc/samba/smb.conf`], { superuser: 'require' });

                await this.reloadSambaService();
                this.shareModal.hide();
                await this.loadShares();
                this.showNotification(`Share "${formData.name}" updated successfully`, 'success');
                
            } catch (error) {
                console.error('Failed to update share:', error);
                this.showNotification('Failed to update share: ' + (error.message || error), 'error');
                submitBtn.disabled = false;
                submitBtn.textContent = originalText;
            }
        }

        async deleteShare(shareName) {
            if (!confirm(`Are you sure you want to delete the share "${shareName}"?`)) {
                return;
            }

            try {
                const configResult = await CommandExecutor.execute(['cat', '/etc/samba/smb.conf']);
                if (!configResult.success || !configResult.data.includes(`[${shareName}]`)) {
                    this.showNotification(`Share "${shareName}" not found in configuration`, 'error');
                    return;
                }
                
                // Create backup
                const backupFile = `/etc/samba/smb.conf.backup.${Date.now()}`;
                await CommandExecutor.execute(['cp', '/etc/samba/smb.conf', backupFile], { superuser: 'require' });
                
                // Delete share section
                const sedCommand = `/^\\[${shareName}\\]/,/^\\[.*\\]/{/^\\[${shareName}\\]/d; /^\\[.*\\]/!d;}`;
                await CommandExecutor.execute(['sed', '-i', sedCommand, '/etc/samba/smb.conf'], { superuser: 'require' });
                
                // Verify deletion
                const updatedResult = await CommandExecutor.execute(['cat', '/etc/samba/smb.conf']);
                if (updatedResult.success && updatedResult.data.includes(`[${shareName}]`)) {
                    throw new Error(`Share [${shareName}] still exists after deletion attempt`);
                }
                
                await this.reloadSambaService();
                await this.loadShares();
                this.showNotification(`Share "${shareName}" deleted successfully`, 'success');
                
            } catch (error) {
                console.error('Share deletion failed:', error);
                this.showNotification('Failed to delete share: ' + (error.message || error), 'error');
            }
        }

        async reloadSambaService() {
            // Test configuration
            await CommandExecutor.execute(['testparm', '-s']);
            
            // Reload Samba service
            const reloadResult = await CommandExecutor.execute(['systemctl', 'reload', 'smb'], { superuser: 'require' });
            if (!reloadResult.success) {
                await CommandExecutor.execute(['systemctl', 'reload', 'smbd'], { superuser: 'require' });
            }
        }

        // Service management methods
        async startService() {
            const servicesToTry = ['smb', 'smbd'];
            const isRestart = this.getElement('start-service-btn').textContent === 'Restart';
            const action = isRestart ? 'restart' : 'start';
            
            for (const service of servicesToTry) {
                const result = await CommandExecutor.execute(['systemctl', action, service], { superuser: 'require' });
                if (result.success) {
                    await new Promise(resolve => setTimeout(resolve, 2000)); // Wait longer for service to fully start
                    this.loadServiceStatus();
                    const message = isRestart ? 'Samba service restarted successfully' : 'Samba service started successfully';
                    this.showNotification(message, 'success');
                    return;
                }
            }
            
            const message = isRestart ? 'Failed to restart Samba service' : 'Failed to start Samba service';
            this.showNotification(message, 'error');
        }

        async stopService() {
            const servicesToTry = ['smb', 'smbd'];
            let success = false;
            
            for (const service of servicesToTry) {
                const result = await CommandExecutor.execute(['systemctl', 'stop', service], { superuser: 'require' });
                if (result.success) {
                    success = true;
                }
            }
            
            if (success) {
                await new Promise(resolve => setTimeout(resolve, 1000));
                this.loadServiceStatus();
                this.showNotification('Samba service stopped successfully', 'success');
            } else {
                this.showNotification('Failed to stop Samba service', 'error');
            }
        }

        // User management methods
        showSambaPasswordModal(username) {
            this.getElement('password-username').textContent = username;
            this.getElement('samba-password-modal').style.display = 'flex';
            this.getElement('samba-password').focus();
        }

        enableSambaUser(username) {
            this.showSambaPasswordModal(username);
        }

        hideSambaPasswordModal() {
            this.getElement('samba-password-modal').style.display = 'none';
            this.clearSambaPasswordForm();
        }

        clearSambaPasswordForm() {
            this.getElement('samba-password').value = '';
            this.getElement('samba-password-confirm').value = '';
        }

        async setSambaPassword() {
            const username = this.getElement('password-username').textContent;
            const password = this.getElement('samba-password').value;
            const confirmPassword = this.getElement('samba-password-confirm').value;

            if (!password) {
                this.showNotification('Password is required', 'error');
                return;
            }

            if (password !== confirmPassword) {
                this.showNotification('Passwords do not match', 'error');
                return;
            }

            await this.withButtonFeedback('set-password-btn', async () => {
                const echoCommand = `echo -e "${password}\\n${password}" | smbpasswd -a -s ${username}`;
                const result = await CommandExecutor.execute(['bash', '-c', echoCommand], { superuser: 'require' });
                
                if (result.success) {
                    this.hideSambaPasswordModal();
                    await this.loadUsers();
                    this.showNotification(`Samba password set for user "${username}"`, 'success');
                } else {
                    // Try alternative method
                    const printfCommand = `printf "${password}\\n${password}\\n" | smbpasswd -a -s ${username}`;
                    const altResult = await CommandExecutor.execute(['bash', '-c', printfCommand], { superuser: 'require' });
                    
                    if (altResult.success) {
                        this.hideSambaPasswordModal();
                        await this.loadUsers();
                        this.showNotification(`Samba password set for user "${username}"`, 'success');
                    } else {
                        this.showNotification(`Failed to set Samba password: ${altResult.error}`, 'error');
                    }
                }
            }, 'Setting password...');
        }

        navigateToUsers() {
            if (typeof cockpit !== 'undefined' && cockpit.jump) {
                cockpit.jump('/users');
            } else if (typeof cockpit !== 'undefined' && cockpit.location) {
                cockpit.location = '/users';
            } else {
                window.location.href = window.location.origin + '/users';
            }
        }

        // Search and filter methods
        filterShares(query) {
            const rows = document.querySelectorAll('#shares-tbody tr:not(.empty-row)');
            const lowerQuery = query.toLowerCase();
            
            rows.forEach(row => {
                const text = row.textContent.toLowerCase();
                row.style.display = text.includes(lowerQuery) ? '' : 'none';
            });
        }

        filterUsers(query) {
            const rows = document.querySelectorAll('#users-tbody tr:not(.empty-row)');
            const lowerQuery = query.toLowerCase();
            
            rows.forEach(row => {
                const text = row.textContent.toLowerCase();
                row.style.display = text.includes(lowerQuery) ? '' : 'none';
            });
        }

        // Table sorting
        setupTableSorting() {
            document.querySelectorAll('.sort-button').forEach(button => {
                button.addEventListener('click', (e) => {
                    const th = e.currentTarget.closest('th');
                    const sortKey = th.dataset.sort;
                    this.sortTable(sortKey, button);
                });
            });
        }

        sortTable(sortKey, button) {
            const currentDirection = button.classList.contains('sort-asc') ? 'asc' : 
                                   button.classList.contains('sort-desc') ? 'desc' : null;
            
            document.querySelectorAll('.sort-button').forEach(btn => {
                btn.classList.remove('sort-asc', 'sort-desc');
            });

            let newDirection;
            if (currentDirection === null || currentDirection === 'desc') {
                newDirection = 'asc';
            } else {
                newDirection = 'desc';
            }

            button.classList.add(`sort-${newDirection}`);

            const dataArray = this.currentTab === 'shares' ? this.shares : this.users;
            dataArray.sort((a, b) => {
                const aVal = (a[sortKey] || '').toString().toLowerCase();
                const bVal = (b[sortKey] || '').toString().toLowerCase();
                const result = aVal.localeCompare(bVal);
                return newDirection === 'asc' ? result : -result;
            });

            if (this.currentTab === 'shares') {
                this.renderShares();
            } else {
                this.renderUsers();
            }
        }

        // Utility methods
        showNotification(message, type = 'info') {
            const banner = this.getElement('action-banner');
            banner.textContent = message;
            banner.className = type;
            banner.style.display = 'block';

            setTimeout(() => {
                banner.style.display = 'none';
            }, 4000);
        }

        escapeHtml(text) {
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        }
    }

    // Initialize app
    let sambaApp;
    window.sambaApp = null;

    document.addEventListener('DOMContentLoaded', function() {
        if (typeof cockpit !== 'undefined') {
            sambaApp = new SambaApp();
            window.sambaApp = sambaApp;
            sambaApp.init();
        } else {
            const checkCockpit = setInterval(() => {
                if (typeof cockpit !== 'undefined') {
                    clearInterval(checkCockpit);
                    sambaApp = new SambaApp();
                    window.sambaApp = sambaApp;
                    sambaApp.init();
                }
            }, 100);
        }
    });

})();

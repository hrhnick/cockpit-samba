# Cockpit Samba Plugin

A modern, user-friendly Cockpit plugin for managing Samba file shares and users on Linux systems.

![Cockpit Samba Plugin Screenshot](https://via.placeholder.com/800x400/0066cc/ffffff?text=Cockpit+Samba+Plugin)

## Features

### 🗂️ Share Management
- **Create and edit shares** with intuitive form interface
- **Path validation** and directory browsing
- **Access control** with user and group permissions
- **Guest access** configuration
- **Read-only/Read-write** permissions
- **Browseable share** settings
- **Real-time configuration validation**

### 👥 User Management
- **View system users** eligible for Samba access
- **Enable/disable Samba** for individual users
- **Set and change Samba passwords** securely
- **Visual status indicators** for enabled users
- **Integration with system user accounts**

### ⚙️ Service Management
- **Service status monitoring** with real-time updates
- **Start, stop, and restart** Samba services
- **Automatic service detection** (smb/smbd/samba)
- **Visual service state indicators**
- **Configuration reload** after changes

### 🎨 Modern Interface
- **Responsive design** that works on desktop and mobile
- **Dark/light theme support** following system preferences
- **PatternFly-inspired** design language
- **Accessibility features** with ARIA labels and keyboard navigation
- **Real-time search and filtering**
- **Sortable tables** with column sorting

## Requirements

### System Requirements
- **Linux distribution** with systemd support
- **Cockpit** version 120 or later
- **Samba** package installed (`samba`, `samba-common-tools`)
- **Root/sudo access** for configuration changes

### Supported Distributions
- ✅ **Fedora** 35+ / **RHEL/CentOS** 8+
- ✅ **Ubuntu** 20.04+ / **Debian** 11+
- ✅ **openSUSE** Leap 15.3+
- ✅ **Arch Linux** (current)

## Installation

### Automatic Installation

1. **Download the plugin:**
   ```bash
   sudo mkdir -p /usr/share/cockpit/samba
   sudo wget -O /tmp/cockpit-samba.tar.gz [DOWNLOAD_URL]
   sudo tar -xzf /tmp/cockpit-samba.tar.gz -C /usr/share/cockpit/samba --strip-components=1
   ```

2. **Install Samba if not already installed:**
   ```bash
   # Fedora/RHEL/CentOS
   sudo dnf install samba samba-common-tools
   
   # Ubuntu/Debian
   sudo apt install samba samba-common-bin
   
   # openSUSE
   sudo zypper install samba samba-client
   
   # Arch Linux
   sudo pacman -S samba
   ```

3. **Restart Cockpit:**
   ```bash
   sudo systemctl restart cockpit
   ```

### Manual Installation

1. **Clone or download** this repository
2. **Copy files** to Cockpit plugins directory:
   ```bash
   sudo cp -r . /usr/share/cockpit/samba/
   sudo chmod 644 /usr/share/cockpit/samba/*
   ```
3. **Restart Cockpit** to load the plugin

### Development Installation

For development and testing:

```bash
# Create local plugin directory
mkdir -p ~/.local/share/cockpit/samba

# Copy plugin files
cp -r . ~/.local/share/cockpit/samba/

# Access via http://localhost:9090
```

## Usage

### Getting Started

1. **Access Cockpit** at `https://your-server:9090`
2. **Log in** with administrative credentials
3. **Navigate** to "File sharing" in the sidebar
4. **Install Samba** if prompted by the setup wizard

### Managing Shares

#### Creating a New Share
1. Click **"Add share"** button
2. Fill in the required information:
   - **Share name**: Unique identifier (letters, numbers, hyphens, underscores only)
   - **Directory path**: Absolute path to the directory to share
   - **Comment**: Optional description
   - **Permissions**: Read-only or read/write access
   - **Guest access**: Allow anonymous access
   - **Browseable**: Show in network browse lists
   - **Valid users**: Specific users/groups (e.g., `john,mary,@sales`)

3. Click **"Create share"** to save

#### Editing Shares
1. Click **"Edit"** next to any share in the table
2. Modify settings as needed
3. Click **"Update share"** to save changes

#### Deleting Shares
1. Click **"Delete"** next to the share
2. Confirm the deletion in the dialog

### Managing Users

#### Enabling Samba for Users
1. Switch to the **"Users"** tab
2. Click **"Enable Samba"** for any disabled user
3. Set a Samba password in the dialog
4. Click **"Set password"** to enable

#### Changing Samba Passwords
1. Click **"Change Password"** for any enabled user
2. Enter and confirm the new password
3. Click **"Set password"** to update

#### Disabling Samba Access
1. Click **"Disable Samba"** for any enabled user
2. Confirm the action to revoke access

### Service Management

- **View service status** in the header section
- **Start/Restart** the service with the green/yellow button
- **Stop** the service with the secondary button
- Service status updates automatically

## Configuration

The plugin manages the standard Samba configuration file at `/etc/samba/smb.conf`. 

### Automatic Backups
- Configuration backups are created before each modification
- Backups are stored as `/etc/samba/smb.conf.backup.[timestamp]`
- Use these backups to restore previous configurations if needed

### Manual Configuration
You can still edit `/etc/samba/smb.conf` manually. The plugin will:
- Read and display existing shares
- Preserve manual configurations
- Validate syntax before applying changes

## Troubleshooting

### Common Issues

**Plugin Not Appearing in Cockpit**
```bash
# Check if files are in the correct location
ls -la /usr/share/cockpit/samba/

# Restart Cockpit
sudo systemctl restart cockpit

# Check Cockpit logs
sudo journalctl -u cockpit
```

**Samba Service Won't Start**
```bash
# Check Samba configuration
sudo testparm

# Check service status
sudo systemctl status smb
sudo systemctl status smbd

# View service logs
sudo journalctl -u smb -f
```

**Permission Denied Errors**
```bash
# Check SELinux context (RHEL/Fedora/CentOS)
sudo setsebool -P samba_enable_home_dirs on
sudo restorecon -R /path/to/share

# Check file permissions
sudo chmod 755 /path/to/share
sudo chown nobody:nobody /path/to/share
```

**Users Can't Access Shares**
```bash
# Verify user exists in Samba database
sudo pdbedit -L

# Check share permissions in smb.conf
sudo cat /etc/samba/smb.conf

# Test with smbclient
smbclient //localhost/sharename -U username
```

### Debug Mode

Enable debug logging in your browser's developer console to see detailed plugin operation logs.

## Development

### Project Structure
```
cockpit-samba/
├── manifest.json      # Plugin metadata and configuration
├── index.html         # Main interface template
├── app.js            # Core application logic
├── style.css         # Styling and responsive design
├── LICENSE           # MIT license
└── README.md         # This file
```

### Contributing

1. **Fork** the repository
2. **Create a feature branch**: `git checkout -b feature-name`
3. **Make changes** and test thoroughly
4. **Follow coding standards**:
   - Use consistent indentation (4 spaces)
   - Add comments for complex logic
   - Test on multiple distributions
5. **Submit a pull request** with clear description

### Building and Testing

```bash
# Install development dependencies
npm install

# Run linting
npm run lint

# Test on local Cockpit instance
make install-local
```

## Security Considerations

- **Always use strong passwords** for Samba users
- **Limit share access** to specific users/groups when possible
- **Regularly update** Samba and system packages
- **Monitor access logs** in `/var/log/samba/`
- **Use firewall rules** to restrict network access
- **Consider encryption** for sensitive data shares

## Support

### Getting Help
- **Issues**: Report bugs via [GitHub Issues](https://github.com/your-repo/cockpit-samba/issues)
- **Discussions**: Join community discussions
- **Documentation**: Check the [Cockpit documentation](https://cockpit-project.org/documentation.html)
- **Samba Help**: Refer to [Samba documentation](https://www.samba.org/samba/docs/)

### Known Limitations
- Requires root access for configuration changes
- Some advanced Samba features not exposed in GUI
- Share paths must exist before creating shares
- Complex ACLs not supported through interface

## Changelog

### Version 1.0.0 (Current)
- ✨ Initial release
- ✨ Share management with full CRUD operations
- ✨ User management and password setting
- ✨ Service status monitoring and control
- ✨ Responsive design with dark/light theme support
- ✨ Real-time validation and error handling
- ✨ Accessibility features and keyboard navigation

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Acknowledgments

- **Cockpit Project** for the excellent web-based server management platform
- **PatternFly** for the design system inspiration
- **Samba Team** for the robust file sharing solution
- **Contributors** who helped improve this plugin

---

**Made with ❤️ for the Linux community**
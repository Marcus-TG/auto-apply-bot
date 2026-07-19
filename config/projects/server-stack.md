# Project: Homelab Infrastructure & Server Stack

## Infrastructure Overview
This project represents a two-year evolution in systems administration and networking. What started as a single virtualization node has grown into a high-availability environment featuring a 10Gb SFP+ Aggregation, Dual-WAN load balancing, and a containerized application server.

## Component 1: Networking & Edge Security
The brain of the network is the Ubiquiti Unifi Dream Machine (UDM).
* **Dual-WAN Load Balancing:** Configured to manage two ISP connections simultaneously, ensuring 99.9% uptime for self-hosted services and automated failover.
* **Aggregation Switch:** A UniFi Pro XG Aggregation serves as the high-speed distribution layer. It directly connects the TrueNAS storage server to the compute nodes via SFP+ DAC cables.
* **Access Switch:** A UniFi Pro XG 48 PoE handles the access layer, providing high-density connectivity while maintaining a 10Gb uplink to the core.
* **Architectural Evolution:** Marcus originally managed the network via OPNsense but moved to the UDM for a unified management interface while maintaining complex VLAN tagging.

## Component 2: Storage Server (TrueNAS)
Running on a dedicated Dell PowerEdge R710, this node handles all data persistence for the lab.
* **File System:** ZFS (configured for bit-rot protection and snapshots).
* **Connectivity:** 10GbE direct-attach to the aggregation switch.
* **Data Redundancy:** RaidZ1 combined with two offsite copies backed up daily for disaster recovery.

## Component 3: Application Server
This is a custom-built, high-performance server designed specifically for high-density container orchestration.
* **OS:** Ubuntu Server (Bare Metal).
* **Orchestration:** Docker & Portainer.
* **Traffic Management:** Nginx Proxy Manager (Handling SSL/Reverse Proxy).
* **Automation:** n8n for self-hosted workflow logic.
* **Architectural Evolution:** This machine replaced a dedicated Proxmox R710 node, moving from full virtualization (VMs) to a more resource-efficient "bare-metal" container strategy.

## Component 4: Security & Network Segmentation
To protect the integrity of the core infrastructure, the network is segmented into isolated VLANs with strict firewall rules:
* **Management VLAN:** Restricted access to the TrueNAS GUI, UDM interface, and Portainer dashboard.
* **Server/DMZ:** Isolated zone for public-facing Docker containers (Nginx, n8n), preventing lateral movement to the rest of the network.
* **IoT Isolation:** All smart devices are confined to a no-internet-access VLAN, communicating only with local controllers.

## Technical Specifications & Hardware
* **Edge Router:** Unifi UDM (Dual-WAN Load Balancing)
* **Aggregation Layer:** Pro XG Aggregation
* **Access Layer:** Pro XG 48 PoE
* **Storage Server:** Dell R710 (Media Server/NAS)
* **App Server:** Custom Whitebox (High Performance Server)
* **Security:** VLAN/Firewall (Intra-VLAN Isolation & DMZ)

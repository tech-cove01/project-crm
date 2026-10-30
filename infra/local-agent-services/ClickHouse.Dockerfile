FROM clickhouse/clickhouse-server:25.12.5.44
COPY clickhouse-low-memory.xml /etc/clickhouse-server/config.d/low-memory.xml
COPY clickhouse-low-memory-users.xml /etc/clickhouse-server/users.d/low-memory.xml

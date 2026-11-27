#!/usr/bin/env python3
"""Build the demo databases the documentation screenshots are taken against.

Deterministic on purpose: the same bytes every run, so a re-shot screenshot never
shows data that contradicts an earlier one. All of it is invented sample data — the
names, orders and events are fixtures, not anything from a real database.

    scripts/make-demo-db.py /tmp/dbdesk-shots
"""

from __future__ import annotations

import sqlite3
import sys
from pathlib import Path

CUSTOMERS = [
    ("Aisiyah Rahman", "aisiyah@example.com", "MY"),
    ("Bilal Hassan", "bilal@example.com", "MY"),
    ("Chloe Lim", "chloe@example.com", "SG"),
    ("Divya Menon", "divya@example.com", "SG"),
    ("Farah Idris", "farah@example.com", "MY"),
    ("Gopal Menon", "gopal@example.com", "MY"),
    ("Hana Lee", "hana@example.com", "KR"),
    ("Imran Shah", "imran@example.com", "PK"),
    ("Jia Wei", "jiawei@example.com", "TW"),
    ("Kavya Nair", "kavya@example.com", "IN"),
    ("Liam Ong", "liam@example.com", "SG"),
    ("Maya Sari", "maya@example.com", "ID"),
    ("Nadia Aziz", "nadia@example.com", "MY"),
    ("Omar Yusof", "omar@example.com", "MY"),
    ("Nurul Izzah", "nurul@example.com", "MY"),
    ("Qistina Rosli", "qistina@example.com", "BN"),
]

ORDERS = [
    (1, 1, 49.90, "paid", "2026-11-05T09:00:00"),
    (2, 2, 12.50, "paid", "2026-11-05T10:00:00"),
    (3, 1, 8.00, "pending", "2026-11-06T11:00:00"),
    (4, 3, 49.90, "paid", "2026-11-06T12:00:00"),
    (5, 4, 21.00, "refunded", "2026-11-07T13:00:00"),
    (6, 5, 95.00, "paid", "2026-11-15T10:00:00"),
    (7, 6, 112.00, "paid", "2026-11-16T10:00:00"),
    (8, 7, 129.00, "paid", "2026-11-17T10:00:00"),
    (9, 8, 26.00, "pending", "2026-11-18T10:00:00"),
    (10, 9, 43.00, "paid", "2026-11-19T10:00:00"),
    (11, 10, 60.00, "paid", "2026-11-20T10:00:00"),
    (12, 11, 77.00, "paid", "2026-11-21T10:00:00"),
    (13, 12, 94.00, "pending", "2026-11-22T10:00:00"),
    (14, 13, 111.00, "paid", "2026-11-23T10:00:00"),
    (15, 14, 128.00, "paid", "2026-11-10T10:00:00"),
    (16, 15, 25.00, "paid", "2026-11-11T10:00:00"),
    (17, 16, 42.00, "pending", "2026-11-12T10:00:00"),
]

PRODUCTS = [
    (1, "Espresso beans 1kg", 42.00, 180),
    (2, "Filter papers (100)", 9.50, 640),
    (3, "Ceramic dripper", 68.00, 54),
    (4, "Cold brew bottle", 24.00, 210),
    (5, "Gift card RM100", 100.00, 999),
]

EVENTS = [
    (1, "order.created", 1, "2026-11-05T09:00:00"),
    (2, "payment.captured", 1, "2026-11-05T09:00:04"),
    (3, "order.created", 5, "2026-11-07T13:00:00"),
    (4, "order.refunded", 5, "2026-11-08T09:12:00"),
    (5, "order.created", 8, "2026-11-17T10:00:00"),
    (6, "payment.captured", 8, "2026-11-17T10:00:03"),
]

SCHEMA = """
create table customers (
  id integer primary key,
  name text not null,
  email text not null,
  country text not null
);
create table orders (
  id integer primary key,
  customer_id integer not null references customers(id),
  total real not null,
  status text not null,
  created_at text not null
);
create table products (
  id integer primary key,
  name text not null,
  price real not null,
  stock integer not null
);
create table events (
  id integer primary key,
  name text not null,
  order_id integer references orders(id),
  created_at text not null
);
create index orders_customer_id on orders(customer_id);
create index events_order_id on events(order_id);
"""


def build(path: Path, *, with_data: bool) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        path.unlink()
    con = sqlite3.connect(path)
    con.executescript(SCHEMA)
    if with_data:
        con.executemany("insert into customers values (?,?,?,?)", [
            (index, *row) for index, row in enumerate(CUSTOMERS, start=1)
        ])
        con.executemany("insert into orders values (?,?,?,?,?)", ORDERS)
        con.executemany("insert into products values (?,?,?,?)", PRODUCTS)
        con.executemany("insert into events values (?,?,?,?)", EVENTS)
    con.commit()
    counts = {
        table: con.execute(f"select count(*) from {table}").fetchone()[0]
        for table in ("customers", "orders", "products", "events")
    }
    con.close()
    print(f"{path}  {counts}")


def main() -> int:
    target = Path(sys.argv[1] if len(sys.argv) > 1 else Path.home() / "Documents" / "DB Desk Demo")
    build(target / "demo.db", with_data=True)
    build(target / "archive.db", with_data=False)
    build(target / "scratch.db", with_data=False)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

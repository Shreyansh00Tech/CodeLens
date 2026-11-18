from app.db import session


def load_item(item_id):
    return session.get(item_id)

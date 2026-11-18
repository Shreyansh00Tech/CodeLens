from flask import jsonify, abort
from app.api import bp
from app.services import load_item
from app.auth_helpers import require_key


@bp.route('/items/<int:item_id>', methods=['GET', 'DELETE'])
@require_key
def get_item(item_id):
    item = load_item(item_id)
    if item is None:
        abort(404)
    return jsonify(item), 200

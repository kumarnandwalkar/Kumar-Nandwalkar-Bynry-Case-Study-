from flask import request, jsonify
from decimal import Decimal, InvalidOperation
from sqlalchemy.exc import IntegrityError

@app.route('/api/products', methods=['POST'])
def create_product():
    data = request.get_json()

    # -------------------------------------------------------
    # Step 1: Validate that the request body exists
    # -------------------------------------------------------
    # If Content-Type isn't application/json or body is empty,
    # request.get_json() returns None. We catch that here.
    if not data:
        return jsonify({"error": "Request body must be valid JSON"}), 400

    # -------------------------------------------------------
    # Step 2: Validate required fields
    # -------------------------------------------------------
    # These fields are mandatory for a product to be meaningful.
    # initial_quantity defaults to 0 if not provided — a reasonable
    # assumption for products being registered before stock arrives.
    required_fields = ['name', 'sku', 'price', 'warehouse_id']
    missing = [f for f in required_fields if f not in data or data[f] is None]
    if missing:
        return jsonify({
            "error": "Missing required fields",
            "missing_fields": missing
        }), 400

    # -------------------------------------------------------
    # Step 3: Validate and sanitize price
    # -------------------------------------------------------
    # Price must be a positive decimal. We use Python's Decimal
    # for precision — floats can cause rounding errors in financial data.
    try:
        price = Decimal(str(data['price']))
        if price < 0:
            raise ValueError("Price cannot be negative")
    except (InvalidOperation, ValueError) as e:
        return jsonify({"error": f"Invalid price: {str(e)}"}), 400

    # -------------------------------------------------------
    # Step 4: initial_quantity defaults to 0
    # -------------------------------------------------------
    # Assumption: It's valid to register a product with 0 stock.
    # This handles cases where a product is being set up before 
    # the first shipment arrives.
    try:
        initial_quantity = int(data.get('initial_quantity', 0))
        if initial_quantity < 0:
            raise ValueError("Quantity cannot be negative")
    except (ValueError, TypeError):
        return jsonify({"error": "initial_quantity must be a non-negative integer"}), 400

    # -------------------------------------------------------
    # Step 5: Check SKU uniqueness at the application layer
    # -------------------------------------------------------
    # We check before inserting to give a clear, friendly error.
    # The DB unique constraint is a safety net, not the primary guard.
    existing = Product.query.filter_by(sku=data['sku']).first()
    if existing:
        return jsonify({
            "error": "SKU already exists",
            "sku": data['sku'],
            "existing_product_id": existing.id
        }), 409  # 409 Conflict is the correct status for duplicate resource

    # -------------------------------------------------------
    # Step 6: Validate warehouse exists
    # -------------------------------------------------------
    # Assumption: A Warehouse model/table exists. We should not 
    # create inventory records pointing to non-existent warehouses.
    warehouse = Warehouse.query.get(data['warehouse_id'])
    if not warehouse:
        return jsonify({"error": "Warehouse not found"}), 404

    # -------------------------------------------------------
    # Step 7: Create product and inventory in ONE transaction
    # -------------------------------------------------------
    # This is the critical fix. Both records are added to the session
    # before any commit happens. If the commit fails for any reason,
    # SQLAlchemy rolls back BOTH — so we never get a product without
    # an inventory record.
    try:
        product = Product(
            name=data['name'].strip(),
            sku=data['sku'].strip().upper(),  # Normalize SKU to uppercase
            price=price,
            description=data.get('description', ''),  # Optional field
        )
        db.session.add(product)
        db.session.flush()  # Flush to get product.id without committing yet

        inventory = Inventory(
            product_id=product.id,
            warehouse_id=data['warehouse_id'],
            quantity=initial_quantity
        )
        db.session.add(inventory)

        db.session.commit()  # Single commit — atomic operation

    except IntegrityError as e:
        db.session.rollback()
        # This catches race conditions where two requests with the same
        # SKU slip through the application-level check simultaneously
        return jsonify({"error": "Database integrity error — SKU may already exist"}), 409
    except Exception as e:
        db.session.rollback()
        # Log e here using your logging framework (e.g., logger.error(str(e)))
        return jsonify({"error": "Internal server error"}), 500

    # -------------------------------------------------------
    # Step 8: Return 201 Created with the new resource info
    # -------------------------------------------------------
    return jsonify({
        "message": "Product created successfully",
        "product_id": product.id,
        "sku": product.sku,
        "warehouse_id": data['warehouse_id'],
        "initial_quantity": initial_quantity
    }), 201

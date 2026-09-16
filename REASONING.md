# Reasoning

## 1. What I was trying to solve

The main problem is managing college AV equipment without depending on a paper register or a manually maintained availability count.

A student should be able to answer a simple question such as:

> "Can I get this camera for the weekend?"

At the same time, the AV staff need enough control to approve requests, know exactly which physical unit was handed out, record returns, calculate late fees, and deal with equipment that is under repair.

The project therefore treats the physical units as the source of truth instead of storing only a number such as "3 cameras available."

## 2. Choosing the stack

I used Node.js with Express for the backend because the project mainly needs HTTP routes, sessions and business logic.

SQLite fits the project because it is a small, single-room inventory system and does not need a separate database server.

The frontend is plain HTML, CSS and JavaScript. This keeps the project simple and avoids adding a build system just for the interface.

The dependencies in the project are Express, express-session, bcryptjs and better-sqlite3.

## 3. Separating HTTP code from business rules

One important design decision was keeping the application rules in `store.js` instead of putting everything inside `server.js`.

`server.js` is mainly responsible for receiving requests, checking whether the user has the right role, calling the relevant store function and returning the result.

`store.js` contains the actual room rules: availability, loan limits, approvals, returns, deposits, late fees, maintenance and handovers.

This separation makes the rules easier to test without having to test every rule through the browser.

## 4. Treating physical units as the source of truth

Equipment and its physical units are separate records.

For example, a camera model can have several units:

```text
Canon Camera
  ├── Canon Camera #1
  ├── Canon Camera #2
  └── Canon Camera #3
```

Each unit can be available, borrowed or in maintenance.

The catalog calculates availability from those unit records. This avoids a common problem where a stored availability number becomes incorrect after a return, cancellation or manual inventory change.

## 5. Why a pending request does not immediately reduce availability

A request is not the same thing as equipment being handed out.

When a student requests an item, the request stays pending and no physical unit is assigned yet.

Only after staff approve the request is a specific unit selected and marked as borrowed.

This keeps the meaning of "available" clear and prevents pending requests from pretending that equipment has already left the room.

## 6. Preventing the same unit from being loaned twice

The database has a partial unique index for approved loans on `unit_id`.

This adds a database-level safety net. Even if application code makes a mistake, SQLite will not allow one physical unit to have two active approved loans.

This is important because inventory consistency should not depend entirely on frontend behaviour.

## 7. Using transactions for important operations

Approvals, returns and handovers involve multiple database changes.

For example, a handover may need to:

1. check the current borrower,
2. check the recipient,
3. check the recipient's loan limit,
4. update the loan,
5. update the transfer record.

These changes should not be partially applied.

The project therefore uses database transactions around these operations so the database either completes the operation or rolls it back.

## 8. Why handovers were designed this way

The handover feature has a specific requirement: equipment should move from one student to another without physically returning to the AV desk.

That creates two important rules:

- the due date must remain the same;
- the availability count must not change.

If the item were temporarily returned, another student could potentially see it as available and request it.

Instead, the same loan keeps the same physical unit and due date while only the borrower changes.

For student-to-student handovers, the recipient must accept first. This prevents a student from silently assigning responsibility to another person.

Staff can also perform the handover directly when both students are present at the desk.

## 9. Preserving loan history

Loan records store values such as the deposit and late-fee rate used for that loan.

This means if staff later change the price of an equipment item, an old loan does not suddenly get a different financial history.

The transfer table also keeps information about previous borrowers and the handover itself.

## 10. Handling maintenance

A broken or unavailable physical unit should not be represented as a fake loan.

The project has a separate maintenance status for units. When a unit is marked for repair, it drops out of the available count.

Once repaired, staff can put it back into service.

## 11. Authentication and roles

There are two roles:

- student
- staff

The backend checks the role before allowing protected operations.

Student registration always creates a student account. Staff registration is protected by the staff role.

Passwords are stored using bcrypt hashes instead of plain text.

Sessions are stored in a cookie-based Express session so the frontend does not have to keep credentials itself.

## 12. Validation and business limits

The application validates several things before changing the database.

Examples include:

- required name, email and password
- basic email format
- minimum password length
- duplicate email prevention
- due date cannot be in the past
- loan cannot exceed the equipment's maximum loan period
- borrower cannot exceed the room's active-loan limit
- inactive students cannot receive loans
- a loan cannot be handed over if it is no longer active
- a handover cannot be accepted by the wrong student

Some of these rules are checked in application code because they depend on the current workflow, while database constraints protect the lower-level data integrity.

## 13. Testing approach

The project has a dedicated `logic.test.js` file that runs the business rules against a temporary SQLite database.

The tests cover normal operations as well as cases that should fail.

One especially important group of tests checks the handover behaviour:

- the transfer starts as pending;
- the original borrower remains responsible until acceptance;
- the wrong recipient cannot accept it;
- the due date is unchanged;
- the same physical unit remains assigned;
- availability does not change.

This was useful because the handover feature changes ownership without changing the physical inventory state.

## 14. Demo data

The demo script creates a realistic-looking room state rather than leaving the application completely empty.

It includes students, an approved camera loan, an overdue projector, a pending microphone request, handovers and a unit under repair.

That makes it easier to demonstrate the application without manually creating every record first.

## 15. Trade-offs and limitations

This is intentionally a small application.

It uses SQLite and a simple session setup because the target is a single college AV room. It is not designed as a production-grade multi-campus inventory platform.

Before exposing it publicly, I would replace the development session secret, change the default staff password, and review deployment security settings.

The frontend is also intentionally kept simple. There is no React or other frontend framework because the workflow does not need one.

## 16. Final design idea

The overall approach is to keep the system simple but make the important inventory rules hard to break.

The key principle is:

**The database should represent what physically exists, while the application controls who is allowed to change it and why.**

That is why individual units, transactions, foreign keys, constraints and tested business rules are used throughout the project.

;;;; A JSON-lines eval service for the free NodeCode lane.
;;;;
;;;; `nodecode trial` reads one form from stdin and evaluates it in a complete
;;;; NodeCode image.  This file turns that one shot into a long-lived service:
;;;; it binds a Unix socket, reads one JSON object per line, and evaluates the
;;;; requested form on its own thread so a slow form never blocks the next
;;;; request.  The protocol mirrors what the NodeCode CLI itself offers the
;;;; model: a yield window, then a running envelope with an id that can be
;;;; polled, awaited or interrupted.
;;;;
;;;;   -> {"op":"eval","form":"(sh \"ls\")","yield_time_ms":1000}
;;;;   <- {"status":"exited","output":"","value":"...","error":false}
;;;;   <- {"status":"running","eval_id":3,"output":"..."}
;;;;   -> {"op":"status","id":3}
;;;;   -> {"op":"interrupt","id":3,"force":false}
;;;;   -> {"op":"list"}
;;;;   -> {"op":"ping"}

(progn
  (require :sb-bsd-sockets)

  (defvar *magpie-evals* (make-hash-table :test 'eql))
  (defvar *magpie-seq* 0)
  ;; The eval tool ships named literals beside the form; NodeCode binds them in
  ;; *eval-strings* and ($ "name") reads them.  Our service evaluates on its own
  ;; threads, so it must bind that special itself.
  (defvar *magpie-strings-symbol* (find-symbol "*EVAL-STRINGS*" :nodecode.evolved))

  (defstruct (magpie-eval (:constructor %make-magpie-eval))
    id thread stream value error-p done-p started-at)

  (defun magpie-json (pairs)
    "Build a JSON object from an alist of (key . value) pairs."
    (let ((table (make-hash-table :test 'equal)))
      (dolist (pair pairs)
        (setf (gethash (car pair) table) (cdr pair)))
      table))

  (defun magpie-drain (ev)
    "Take everything the evaluation has printed since the last look."
    (let ((stream (magpie-eval-stream ev)))
      (if stream (get-output-stream-string stream) "")))

  (defun magpie-start (form-text &optional strings)
    (let* ((id (incf *magpie-seq*))
           (stream (make-string-output-stream))
           (ev (%make-magpie-eval :id id :stream stream
                                  :started-at (get-universal-time)))
           (bind-strings (and *magpie-strings-symbol*
                              (hash-table-p strings)
                              (boundp *magpie-strings-symbol*))))
      (setf (gethash id *magpie-evals*) ev)
      (setf (magpie-eval-thread ev)
            (sb-thread:make-thread
             (lambda ()
               (progv (if bind-strings (list *magpie-strings-symbol*) '())
                      (if bind-strings (list strings) '())
                 (let ((*standard-output* stream)
                       (*error-output* stream)
                       (*trace-output* stream))
                   (handler-case
                       (multiple-value-bind (text err) (eval-string form-text)
                         (setf (magpie-eval-value ev) (magpie-display-text text)
                               (magpie-eval-error-p ev) (and err t)))
                     (error (e)
                       (setf (magpie-eval-value ev) (format nil "ERROR: ~a" e)
                             (magpie-eval-error-p ev) t))))
                 (setf (magpie-eval-done-p ev) t)))
             :name (format nil "magpie-eval-~d" id)))
      ev))

  (defun magpie-park (ev yield-ms)
    "Wait up to YIELD-MS for EV, then answer whether it finished."
    (when (and (plusp yield-ms) (not (magpie-eval-done-p ev)))
      (handler-case
          (sb-thread:join-thread (magpie-eval-thread ev)
                                 :timeout (/ yield-ms 1000.0)
                                 :default :timeout)
        (error () nil)))
    (magpie-eval-done-p ev))

  (defun magpie-display-text (text)
    "Show a lone printed string literal as the text it is, as the CLI does."
    (let ((trimmed (string-trim '(#\Space #\Tab #\Newline #\Return) (or text ""))))
      (if (and (> (length trimmed) 1) (char= #\" (char trimmed 0)))
          (let ((*read-eval* nil))
            (handler-case
                (multiple-value-bind (value end) (read-from-string trimmed)
                  (if (and (stringp value) (plusp (length value)) (= end (length trimmed)))
                      value
                      text))
              (error () text)))
          text)))

  (defun magpie-exited (ev)
    (magpie-json
     (list (cons "status" "exited")
           (cons "eval_id" (magpie-eval-id ev))
           (cons "output" (magpie-drain ev))
           (cons "value" (or (magpie-eval-value ev) ""))
           (cons "error" (and (magpie-eval-error-p ev) t)))))

  (defun magpie-running (ev)
    (magpie-json
     (list (cons "status" "running")
           (cons "eval_id" (magpie-eval-id ev))
           (cons "output" (magpie-drain ev)))))

  (defun magpie-find (id)
    (gethash (if (integerp id) id (ignore-errors (parse-integer (princ-to-string id))))
             *magpie-evals*))

  (defun magpie-eval-status (id)
    "One non-blocking look at a background eval started by this session.
Returns readable text, the same lane as every other eval answer."
    (let ((ev (magpie-find id)))
      (if (null ev)
          (format nil "eval ~a: unknown" id)
          (let ((output (magpie-drain ev))
                (done (magpie-eval-done-p ev)))
            (with-output-to-string (out)
              (format out "eval ~a: ~a" (magpie-eval-id ev)
                      (if done "exited" "running"))
              (unless (string= output "")
                (format out "~%output:~%~a" output))
              (when (and done (magpie-eval-value ev))
                (format out "~%value: ~a" (magpie-eval-value ev))))))))

  (defun magpie-eval-await (id &key (yield-ms 10000) until-exit)
    "Park until EVAL ID finishes (or prints), at most YIELD-MS."
    (let ((ev (magpie-find id)))
      (when ev
        (if until-exit
            (ignore-errors (sb-thread:join-thread (magpie-eval-thread ev)))
            (magpie-park ev yield-ms)))
      (magpie-eval-status id)))

  (defun magpie-eval-interrupt (id &key force)
    "Abort EVAL ID."
    (let ((ev (magpie-find id)))
      (when ev
        (let ((thread (magpie-eval-thread ev)))
          (when (and thread (sb-thread:thread-alive-p thread))
            (if force
                (sb-thread:terminate-thread thread)
                (ignore-errors
                  (sb-thread:interrupt-thread
                   thread (lambda () (error "eval interrupted by the client"))))))))
      :ok))

  (defun magpie-eval-list ()
    "Every eval this session started, newest first."
    (let ((rows '()))
      (maphash (lambda (id ev)
                 (declare (ignore id))
                 (push (list (magpie-eval-id ev)
                             (if (magpie-eval-done-p ev) "exited" "running"))
                       rows))
               *magpie-evals*)
      (setf rows (sort rows #'< :key #'first))
      (with-output-to-string (out)
        (if (null rows)
            (write-string "no evals in this session" out)
            (dolist (row rows)
              (format out "~a  ~a~%" (first row) (second row)))))))

  (defun magpie-op-eval (request)
    (let* ((form (gethash "form" request))
           (yield-ms (or (gethash "yield_time_ms" request) 10000))
           (ev (magpie-start form (gethash "strings" request))))
      (if (magpie-park ev yield-ms)
          (magpie-exited ev)
          (magpie-running ev))))

  (defun magpie-op-status (request)
    (let ((ev (magpie-find (gethash "id" request))))
      (cond ((null ev)
             (magpie-json (list (cons "status" "unknown")
                                (cons "eval_id" (gethash "id" request)))))
            ((magpie-eval-done-p ev) (magpie-exited ev))
            (t (magpie-running ev)))))

  (defun magpie-op-interrupt (request)
    (let ((ev (magpie-find (gethash "id" request))))
      (when ev
        (let ((thread (magpie-eval-thread ev)))
          (when (and thread (sb-thread:thread-alive-p thread))
            (if (gethash "force" request)
                (sb-thread:terminate-thread thread)
                (ignore-errors
                  (sb-thread:interrupt-thread
                   thread
                   (lambda ()
                     (error "eval interrupted by the client"))))))))
      (magpie-json (list (cons "status" "ok")))))

  (defun magpie-op-list (request)
    (declare (ignore request))
    (let ((rows '()))
      (maphash (lambda (id ev)
                 (declare (ignore id))
                 (push (magpie-json
                        (list (cons "eval_id" (magpie-eval-id ev))
                              (cons "status" (if (magpie-eval-done-p ev) "exited" "running"))
                              (cons "value" (or (magpie-eval-value ev) ""))))
                       rows))
               *magpie-evals*)
      (magpie-json (list (cons "status" "ok") (cons "evals" (coerce rows 'vector))))))

  (defun magpie-dispatch (request)
    (let ((op (gethash "op" request)))
      (cond ((equal op "eval") (magpie-op-eval request))
            ((equal op "status") (magpie-op-status request))
            ((equal op "interrupt") (magpie-op-interrupt request))
            ((equal op "list") (magpie-op-list request))
            ((equal op "ping") (magpie-json (list (cons "status" "ok"))))
            (t (magpie-json (list (cons "status" "error")
                                  (cons "message" (format nil "unknown op: ~a" op))))))))

  (defun magpie-serve-line (stream line)
    (let* ((request (handler-case (nlk:decode-json line :whole t)
                      (error () (make-hash-table :test 'equal))))
           (req-id (gethash "req_id" request))
           (response
             (handler-case
                 (magpie-dispatch request)
               (error (e)
                 (magpie-json (list (cons "status" "error")
                                    (cons "message" (format nil "~a" e))))))))
      (when req-id (setf (gethash "req_id" response) req-id))
      (format stream "~a~%" (nlk:encode-json-object response))
      (finish-output stream)))

  (let* ((path __MAGPIE_SOCKET__)
         (sock (make-instance 'sb-bsd-sockets:local-socket :type :stream :protocol 0)))
    (when (probe-file path) (delete-file path))
    (sb-bsd-sockets:socket-bind sock path)
    (sb-bsd-sockets:socket-listen sock 16)
    (loop
      (let ((conn (sb-bsd-sockets:socket-accept sock)))
        (unwind-protect
             (with-open-stream
                 (stream (sb-bsd-sockets:socket-make-stream conn :input t :output t
                                                           :element-type 'character
                                                           :buffering :full))
               (loop
                 (let ((line (read-line stream nil :eof)))
                   (when (eq line :eof) (return))
                   (unless (zerop (length (string-trim '(#\Space #\Tab #\Return) line)))
                     (magpie-serve-line stream line)))))
          (sb-bsd-sockets:socket-close conn))))))

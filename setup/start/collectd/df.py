import collectd,os,subprocess

# https://blog.dbrgn.ch/2017/3/10/write-a-collectd-python-plugin/

disks = []

def init():
    global disks
    lines = [s.split() for s in subprocess.check_output(["df", "--type=ext4", "--output=source,target,size,used,avail"]).splitlines()]
    disks = lines[1:] # strip header
    collectd.info('custom df plugin initialized with %s' % disks)

def read():
    for d in disks:
        device = d[0]
        if 'devicemapper' in d[1] or not device.startswith('/dev/'): continue
        instance = device[len('/dev/'):].replace('/', '_') # see #348

        try:
            st = os.statvfs(d[1]) # handle disk removal
        except:
            continue

        val = collectd.Values(type='df_complex', plugin='df', plugin_instance=instance)

        free = st.f_bavail * st.f_frsize # bavail is for non-root user. bfree is total
        val.dispatch(values=[free], type_instance='free')

        reserved = (st.f_bfree - st.f_bavail) * st.f_frsize # root took these
        val.dispatch(values=[reserved], type_instance='reserved')

        used = (st.f_blocks - st.f_bfree) * st.f_frsize
        val.dispatch(values=[used], type_instance='used')

collectd.register_init(init)
collectd.register_read(read)
